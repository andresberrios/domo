import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bus } from './bus'
import { getAppUpdate, restartBlockers, saveAppUpdate } from './repo'
import { getSettings } from './settings'
import type { AppUpdate, AppUpdateCommit, UpdateSettings } from '../../shared/types'

/**
 * Updates of an installed Domo. See `docs/install-and-updates.md`.
 *
 * The launcher (`bin/domo.mjs`) owns git and the builds; this module owns the
 * timing, because the server is the only process that knows whether a
 * restart would interrupt an agent. It asks the launcher for a check, starts
 * it building, and once `current` points at the new release it stops this
 * server at the first quiet moment by leaving the `restart-requested` file
 * for the supervisor. Everything it knows is in the `app_update` row.
 *
 * Under `pnpm dev` there is no `DOMO_HOME`, and none of this runs.
 */

/** What the server knows about the install it is running from. */
export interface InstallInfo {
  home: string
  /** The release this process runs from (`build.json` in its cwd). */
  commit: string
  builtAt: string
}

export function installInfo(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): InstallInfo | null {
  const home = env.DOMO_HOME
  if (!home) return null
  try {
    const build = JSON.parse(readFileSync(join(cwd, 'build.json'), 'utf8')) as { commit?: string, builtAt?: string }
    if (!build.commit) return null
    return { home, commit: build.commit, builtAt: build.builtAt ?? new Date(0).toISOString() }
  } catch {
    return null
  }
}

export interface CheckResult {
  channel: string
  installed: string
  target: string
  behind: number | null
  commits: AppUpdateCommit[]
}

/**
 * Whether a check should go on to build and switch by itself. Pure, so the
 * rule is testable: the switch must be on, there must be something new that
 * has not just failed, and the last switch must be long enough ago.
 */
export function shouldAutoApply(input: {
  settings: UpdateSettings
  check: Pick<CheckResult, 'behind' | 'target'>
  state: AppUpdate['state']
  lastAppliedAt: string | null
  failedTarget: string | null
  now?: Date
}): boolean {
  const { settings, check, state, lastAppliedAt, failedTarget } = input
  if (!settings.autoApply) return false
  if (check.behind === 0) return false
  if (state !== 'idle' && state !== 'failed') return false
  if (failedTarget && failedTarget === check.target) return false
  if (lastAppliedAt) {
    const since = (input.now ?? new Date()).getTime() - new Date(lastAppliedAt).getTime()
    if (since < settings.minHoursBetweenApplies * 3_600_000) return false
  }
  return true
}

const FIRST_CHECK_MS = 20_000
const QUIET_POLL_MS = 30_000

export class Updater {
  private info: InstallInfo | null = null
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private row: AppUpdate | null = null
  private checking: Promise<CheckResult | null> | null = null
  private building: Promise<void> | null = null
  /** The target of the last failed attempt, so auto-apply does not retry it every hour. */
  private failedTarget: string | null = null
  private stopped = true

  get installed(): boolean {
    return this.info !== null
  }

  async start(info = installInfo()): Promise<void> {
    if (!this.stopped || !info) return
    this.stopped = false
    this.info = info
    await this.reconcile()
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type === 'settings-changed') this.schedule(5_000)
    })
    this.schedule(FIRST_CHECK_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.checkTimer) clearTimeout(this.checkTimer)
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.checkTimer = this.quietTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * What happened before this boot: a rollback the supervisor recorded, a
   * build the previous server started that is still running, or a release
   * that was switched to and is waiting for its restart.
   */
  private async reconcile(): Promise<void> {
    const info = this.info!
    const existing = await getAppUpdate()
    const settings = (await getSettings()).updates
    const fresh = !existing || existing.installedCommit !== info.commit
    const row: Omit<AppUpdate, 'updatedAt'> = {
      installedCommit: info.commit,
      installedAt: info.builtAt,
      channel: settings.channel,
      targetCommit: fresh ? null : existing.targetCommit,
      behind: fresh ? null : existing.behind,
      commits: fresh ? [] : existing.commits,
      checkedAt: fresh ? null : existing.checkedAt,
      state: 'idle',
      blockers: [],
      lastError: null,
      lastAppliedAt: existing?.lastAppliedAt ?? null
    }
    // Coming up on a new commit after a `ready` is the switch completing.
    if (existing && existing.state !== 'idle' && existing.installedCommit !== info.commit) {
      row.lastAppliedAt = new Date().toISOString()
    }
    const failed = this.readJson<{ release?: string, rolledBackTo?: string, reason?: string, at?: string }>(join(info.home, 'update-failed.json'))
    if (failed?.rolledBackTo === info.commit && failed.release) {
      row.state = 'failed'
      row.lastError = `Version ${failed.release.slice(0, 7)} ${failed.reason ?? 'did not start'}; Domo went back to this one.`
      this.failedTarget = failed.release
    }
    const lock = this.readJson<{ pid?: number }>(join(info.home, 'update.lock'))
    if (lock?.pid && this.alive(lock.pid)) {
      row.state = 'building'
      void this.watchLock(lock.pid)
    } else if (this.currentCommit() !== info.commit) {
      // Built and switched, not restarted: the previous server stopped first.
      row.state = 'ready'
      this.waitForQuiet()
    }
    this.row = await saveAppUpdate(row)
  }

  private schedule(ms?: number): void {
    if (this.stopped) return
    if (this.checkTimer) clearTimeout(this.checkTimer)
    void getSettings().then((settings) => {
      if (this.stopped) return
      this.checkTimer = setTimeout(() => void this.check(), ms ?? settings.updates.checkIntervalMinutes * 60_000)
      this.checkTimer.unref?.()
    })
  }

  /** Fetch the channel and record where the install stands. */
  check(): Promise<CheckResult | null> {
    if (this.checking) return this.checking
    this.checking = this.doCheck().finally(() => {
      this.checking = null
      this.schedule()
    })
    return this.checking
  }

  private async doCheck(): Promise<CheckResult | null> {
    const row = this.row
    if (!this.info || !row) return null
    if (row.state === 'building' || row.state === 'restarting') return null
    const settings = (await getSettings()).updates
    // Only an idle row shows "checking": a failed or ready one has more to say.
    await this.save({ state: row.state === 'idle' ? 'checking' : row.state, channel: settings.channel })
    try {
      const output = await this.launcher(['update', '--check', '--json', '--channel', settings.channel])
      const line = output.trim().split('\n').filter(l => l.startsWith('{')).pop()
      if (!line) throw new Error(output.trim().split('\n').pop() || 'the check printed nothing')
      const check = JSON.parse(line) as CheckResult
      // The update was built and switched while this server kept running.
      const ready = this.currentCommit() !== this.info.commit
      await this.save({
        state: ready ? 'ready' : row.state === 'failed' ? 'failed' : 'idle',
        channel: check.channel,
        targetCommit: check.target,
        behind: check.behind,
        commits: check.commits,
        checkedAt: new Date().toISOString()
      })
      if (ready) this.waitForQuiet()
      else if (shouldAutoApply({ settings, check, state: this.row!.state, lastAppliedAt: this.row!.lastAppliedAt, failedTarget: this.failedTarget })) {
        void this.apply()
      }
      return check
    } catch (error) {
      await this.save({ state: row.state === 'checking' ? 'idle' : row.state, lastError: `Could not check for updates: ${message(error)}` })
      return null
    }
  }

  /** Build the channel's tip beside this release and switch `current` to it, then restart when quiet. */
  apply(): Promise<void> {
    if (this.building) return this.building
    this.building = this.doApply().finally(() => {
      this.building = null
    })
    return this.building
  }

  private async doApply(): Promise<void> {
    const info = this.info
    if (!info || !this.row) return
    if (this.row.state === 'building' || this.row.state === 'ready' || this.row.state === 'restarting') return
    const settings = (await getSettings()).updates
    await this.save({ state: 'building', lastError: null, blockers: [] })
    try {
      await this.launcher(['update', '--no-restart', '--channel', settings.channel], true)
      if (this.currentCommit() === info.commit) {
        // Nothing to switch to: the channel had nothing new after all.
        await this.save({ state: 'idle', behind: 0, commits: [] })
        return
      }
      await this.save({ state: 'ready' })
      this.waitForQuiet()
    } catch (error) {
      this.failedTarget = this.row?.targetCommit ?? null
      await this.save({ state: 'failed', lastError: `The update failed: ${message(error)}` })
    }
  }

  /** Restart onto `current` now if nothing is running, otherwise keep looking every half minute. */
  waitForQuiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
    void this.tryRestart(false).then((restarting) => {
      if (restarting || this.stopped) return
      this.quietTimer = setTimeout(() => this.waitForQuiet(), QUIET_POLL_MS)
      this.quietTimer.unref?.()
    })
  }

  /**
   * Stop this server so the supervisor starts `current`. Returns false when
   * something is running and `force` was not asked.
   */
  async tryRestart(force: boolean): Promise<boolean> {
    if (!this.info || !this.row) return false
    if (this.row.state !== 'ready') return false
    const blockers = await restartBlockers()
    if (blockers.length && !force) {
      if (JSON.stringify(blockers) !== JSON.stringify(this.row.blockers)) await this.save({ blockers })
      return false
    }
    await this.save({ state: 'restarting', blockers: [] })
    writeFileSync(join(this.info.home, 'restart-requested'), new Date().toISOString())
    console.log('[updates] restarting onto the new version')
    // Nitro's shutdown runs the close hooks (adapters, voice) and exits.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref?.()
    return true
  }

  private async watchLock(pid: number): Promise<void> {
    while (!this.stopped && this.alive(pid)) await new Promise(r => setTimeout(r, 5_000))
    if (this.stopped) return
    if (this.currentCommit() !== this.info?.commit) {
      await this.save({ state: 'ready' })
      this.waitForQuiet()
    } else {
      await this.save({ state: 'idle' })
      void this.check()
    }
  }

  /** Run the launcher; with `log`, its output is appended to `logs/update.log` and the tail is the error. */
  private launcher(args: string[], log = false): Promise<string> {
    const info = this.info!
    return new Promise((resolve, reject) => {
      const file = join(info.home, 'logs', 'update.log')
      let fd: number | undefined
      if (log) {
        mkdirSync(join(info.home, 'logs'), { recursive: true })
        fd = openSync(file, 'a')
      }
      const child = spawn(process.execPath, [join(info.home, 'bin', 'domo.mjs'), ...args], {
        env: { ...process.env, DOMO_HOME: info.home },
        stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe'],
        // The build goes on if this server is restarted under it; the lock
        // file tells the next server so.
        detached: log
      })
      if (fd !== undefined) closeSync(fd)
      let output = ''
      child.stdout?.on('data', d => (output += d))
      child.stderr?.on('data', d => (output += d))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) return resolve(output)
        const tail = log ? this.tail(file) : output
        reject(new Error(tail.trim().split('\n').slice(-6).join('\n') || `exit ${code}`))
      })
    })
  }

  private currentCommit(): string | null {
    try {
      return basename(realpathSync(join(this.info!.home, 'current')))
    } catch {
      return null
    }
  }

  private async save(patch: Partial<Omit<AppUpdate, 'updatedAt'>>): Promise<void> {
    if (!this.row) return
    const { updatedAt: _ignored, ...rest } = this.row
    this.row = await saveAppUpdate({ ...rest, ...patch })
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private tail(file: string): string {
    try {
      return readFileSync(file, 'utf8').slice(-4000)
    } catch {
      return ''
    }
  }

  /** For tests and the failed-record path: forget a rollback once the user retries. */
  clearFailure(): void {
    if (this.info) rmSync(join(this.info.home, 'update-failed.json'), { force: true })
    this.failedTarget = null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const updater = new Updater()
