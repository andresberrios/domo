import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Where `scripts/install.sh` gets git from, on a PATH that has no git: the
 * machine's tools are linked in one by one, and `uname`, `docker`, `curl`,
 * `sudo` and the package managers are fakes that write down what they were
 * asked. Offline: the real download is the Linux container test's
 * (docs/install-and-updates.md).
 */

const SCRIPT = join(process.cwd(), 'scripts', 'install.sh')
const FAKED = new Set(['git', 'curl', 'docker', 'uname', 'id', 'sudo', 'xcode-select', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk'])

let root: string
let bin: string
let calls: string

async function fake(name: string, body: string) {
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
  await chmod(join(bin, name), 0o755)
}

/** A git that answers `--version` and fails everything else, so the install stops right after choosing it. */
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
  await fake('curl', 'echo "curl $*" >> "$CALLS"; while [ $# -gt 0 ]; do [ "$1" = -o ] && echo not-a-tarball > "$2"; shift; done')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function install(os: 'Linux' | 'Darwin') {
  const result = spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: root, DOMO_HOME: join(root, 'home'), DOMO_REPO: 'file:///nowhere', FAKE_OS: os, CALLS: calls }
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

const logged = () => readFile(calls, 'utf8').catch(() => '')

describe('install.sh and git', () => {
  it('uses the machine\'s git when it runs, and installs nothing', async () => {
    await fake('git', FAKE_GIT)
    await fake('apt-get', 'echo "apt-get $*" >> "$CALLS"')

    install('Linux')

    expect(await logged()).not.toMatch(/apt-get|curl .*dugite/)
    expect(await logged()).toContain('git clone')
  })

  it('on Linux without git, installs the distribution\'s package with sudo', async () => {
    // Installing it puts a git on the PATH, as the real package would.
    await fake('apt-get', `echo "apt-get $*" >> "$CALLS"; [ "$1" = install ] && cat > "${bin}/git" <<'G' && chmod +x "${bin}/git"\n#!/bin/sh\n${FAKE_GIT}\nG\nexit 0`)

    const { output } = install('Linux')

    expect(output).toContain('Installing git: sudo apt-get install -y -qq git (sudo may ask for your password)')
    expect((await logged()).split('\n')).toEqual(expect.arrayContaining([
      'sudo apt-get update -qq', 'sudo apt-get install -y -qq git', 'git --version', expect.stringMatching(/^git clone /)
    ]))
  })

  it('on Linux without git or a known package manager, says so and stops', async () => {
    const { status, output } = install('Linux')

    expect(status).toBe(1)
    expect(output).toContain('git is required; install it with your package manager')
    expect(await logged()).toBe('')
  })

  it('on macOS without a git that runs, downloads Domo\'s own instead of the Command Line Tools, and checks it', async () => {
    await fake('xcode-select', 'echo "xcode-select $*" >> "$CALLS"; exit 2')
    await fake('apt-get', 'echo "apt-get $*" >> "$CALLS"')

    const { status, output } = install('Darwin')

    expect(output).toContain('Downloading git (2.53.0-4)')
    expect(await logged()).toMatch(/curl .*dugite-native-v2\.53\.0-4-4098283-macOS-arm64\.tar\.gz/)
    // The fake download is not the pinned file.
    expect(status).toBe(1)
    expect(output).toContain('does not match its checksum')
    expect(await logged()).not.toMatch(/apt-get|xcode-select --install/)
  })

  it('pins the same build as the launcher, which keeps an existing one at that version', async () => {
    const script = await readFile(SCRIPT, 'utf8')
    const launcher = await readFile(join(process.cwd(), 'bin', 'domo.mjs'), 'utf8')
    const release = script.match(/^GIT_RELEASE=(\S+)$/m)![1]
    const build = script.match(/^GIT_BUILD=(\S+)$/m)![1]
    expect(launcher).toContain(`release: '${release}'`)
    expect(launcher).toContain(`build: '${build}'`)
    const sums = [...script.matchAll(/asset=(\S+) sum=([0-9a-f]{64})/g)].map(([, asset, sum]) => [asset, sum])
    expect(sums).toHaveLength(4)
    for (const [asset, sum] of sums) expect(launcher).toContain(`['${asset}', '${sum}']`)
  })
})
