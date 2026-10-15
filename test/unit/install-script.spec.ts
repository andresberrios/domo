import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Where `scripts/install.sh` gets git from, on a PATH that has no git: the
 * machine's tools are linked in one by one, and `uname`, `docker`, `sudo`,
 * the package managers, `xcode-select` and `pgrep` (Apple's install dialog)
 * are fakes that write down what they were asked. The real apt install is the
 * Linux container test's (docs/install-and-updates.md).
 */

const SCRIPT = join(process.cwd(), 'scripts', 'install.sh')
const FAKED = new Set(['git', 'curl', 'docker', 'uname', 'id', 'sudo', 'xcode-select', 'pgrep', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk'])

let root: string
let bin: string
let calls: string

async function fake(name: string, body: string) {
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
  await chmod(join(bin, name), 0o755)
}

/** A git that answers `--version` and fails everything else. The fake curl fails, so the install stops at the manifest. */
const FAKE_GIT = 'echo "git $*" >> "$CALLS"; [ "$1" = --version ] && echo "git version 0" && exit 0; exit 1'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'domo-inst-'))
  bin = join(root, 'bin')
  calls = join(root, 'calls.log')
  await mkdir(bin)
  for (const dir of ['/bin', '/usr/bin', '/sbin', '/usr/sbin']) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (FAKED.has(name)) continue
      await symlink(join(dir, name), join(bin, name)).catch(() => null)
    }
  }
  await fake('docker', 'exit 0')
  await fake('id', '[ "$1" = -u ] && echo 1000 || exec /usr/bin/id "$@"')
  await fake('uname', '[ "$1" = -m ] && echo arm64 || echo "$FAKE_OS"')
  await fake('sudo', 'echo "sudo $*" >> "$CALLS"; exec "$@"')
  await fake('curl', 'echo "curl $*" >> "$CALLS"; exit 1')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function install(os: 'Linux' | 'Darwin') {
  const result = spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: root, DOMO_HOME: join(root, 'home'), DOMO_FEED: 'http://feed.invalid', FAKE_OS: os, CALLS: calls }
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

const logged = () => readFile(calls, 'utf8').catch(() => '')

describe('install.sh and git', () => {
  it('uses the machine\'s git when it runs, and installs nothing', async () => {
    await fake('git', FAKE_GIT)
    await fake('apt-get', 'echo "apt-get $*" >> "$CALLS"')

    install('Linux')

    expect(await logged()).not.toMatch(/apt-get|xcode-select/)
    expect(await logged()).toContain('curl -fsSL http://feed.invalid/latest/download/manifest.json')
  })

  it('on Linux without git, installs the distribution\'s package with sudo', async () => {
    // Installing it puts a git on the PATH, as the real package would.
    await fake('apt-get', `echo "apt-get $*" >> "$CALLS"; [ "$1" = install ] && cat > "${bin}/git" <<'G' && chmod +x "${bin}/git"\n#!/bin/sh\n${FAKE_GIT}\nG\nexit 0`)

    const { output } = install('Linux')

    expect(output).toContain('Installing git: sudo apt-get install -y -qq git (sudo may ask for your password)')
    expect((await logged()).split('\n')).toEqual(expect.arrayContaining([
      'sudo apt-get update -qq', 'sudo apt-get install -y -qq git', 'git --version', expect.stringMatching(/^curl .*manifest\.json/)
    ]))
  })

  it('on Linux without git or a known package manager, says so and stops', async () => {
    const { status, output } = install('Linux')

    expect(status).toBe(1)
    expect(output).toContain('git is required; install it with your package manager')
    expect(await logged()).toBe('')
  })

  describe('on macOS without a git that runs', () => {
    // The dialog's process is there on the first look; what happens next is the test's.
    const dialog = (then: string) => fake('pgrep', `n=$(cat "$CALLS.pgrep" 2>/dev/null || echo 0); echo $((n + 1)) > "$CALLS.pgrep"
[ "$n" = 0 ] && exit 0
${then}`)

    beforeEach(async () => {
      await fake('xcode-select', 'echo "xcode-select $*" >> "$CALLS"; [ "$1" = --install ] && echo "install requested" && exit 0; exit 2')
    })

    it('starts Apple\'s Command Line Tools install, waits for it, and goes on', async () => {
      // Finishing puts git on the PATH, as the tools would.
      await dialog(`cat > "${bin}/git" <<'G' && chmod +x "${bin}/git"\n#!/bin/sh\n${FAKE_GIT}\nG\nexit 0`)

      const { output } = install('Darwin')

      expect(output).toContain('A macOS dialog is asking to install them')
      expect(output).toContain('Command Line Tools installed')
      expect((await logged()).split('\n')).toEqual(expect.arrayContaining([
        'xcode-select --install', 'git --version', expect.stringMatching(/^curl .*manifest\.json/)
      ]))
      expect(await logged()).not.toMatch(/apt-get/)
    }, 20_000)

    it('stops with what to do when the dialog goes away without installing', async () => {
      await dialog('exit 1')

      const { status, output } = install('Darwin')

      expect(status).toBe(1)
      expect(output).toContain('the Command Line Tools were not installed (the dialog was cancelled or failed)')
      expect(await logged()).not.toMatch(/curl/)
    }, 20_000)

    it('stops at once when xcode-select refuses to start the install', async () => {
      await fake('xcode-select', 'echo "xcode-select $*" >> "$CALLS"; echo "xcode-select: error: no GUI session" >&2; exit 1')

      const { status, output } = install('Darwin')

      expect(status).toBe(1)
      expect(output).toContain('xcode-select --install failed: xcode-select: error: no GUI session')
    })
  })
})
