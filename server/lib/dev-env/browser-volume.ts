import { createHash } from 'node:crypto'

import { dockerServerArch, resourcePrefix, run } from './docker'
import { RUNTIME_IMAGE, RUNTIME_ROOT } from './runtime-volume'

/**
 * A headless Chromium for every environment, in a shared read-only volume.
 *
 * The same shape as the runtime volume beside it, and for the same reason: the
 * project picks the environment's image, so nothing Domo needs may depend on
 * what is in it. A devcontainer Feature would put ~500 MB into every project's
 * image and only reach projects whose `.domo.json` names it; an install at
 * container start needs apt, network and root in an image Domo does not own.
 *
 * Built from `RUNTIME_IMAGE` rather than an image of its own, because the
 * libraries copied out of it have to run on every environment image and a
 * library built against a newer glibc will not. Sharing the pin with the
 * bundled Node keeps both on one floor instead of two that can drift apart.
 */
export const BROWSER_ROOT = '/opt/domo-browser'

export const BROWSER_PACKAGES = {
  playwright: 'playwright-core@1.63.0',
  mcp: '@playwright/mcp@0.0.82'
}

/**
 * The Debian packages the headless shell needs. Deliberately not Playwright's
 * own `install-deps` list, which is 94 packages because it carries the whole
 * Xvfb and X server stack for headed mode.
 */
const BROWSER_APT_PACKAGES = [
  'libnss3', 'libnspr4', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2', 'libdrm2',
  'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1',
  'libpango-1.0-0', 'libcairo2', 'libasound2', 'libexpat1', 'libxext6', 'libx11-6',
  'libxcb1', 'fonts-liberation'
]

/**
 * The libraries that must come from the environment's own image and never from
 * the volume: glibc itself and the two runtimes versioned against it.
 *
 * These are on the list because the volume's `lib` directory goes on
 * `LD_LIBRARY_PATH`, which is searched before the system paths *for every
 * library the process loads*. Ship bookworm's `libc.so.6` and an Ubuntu 24.04
 * image resolves its own newer `libstdc++` against it, which fails — measured:
 * `libc.so.6: version 'GLIBC_2.38' not found (required by libstdc++.so.6)`,
 * and it kills Node before the browser is even launched. Chromium is built to
 * run on an older glibc than any image Domo supports, so taking these from the
 * image is also the correct direction.
 */
const IMAGE_OWNED_LIBRARIES = [
  'ld-linux', 'libc.so', 'libm.so', 'libpthread.so', 'libdl.so', 'librt.so',
  'libresolv.so', 'libnsl.so', 'libutil.so', 'libcrypt.so', 'libanl.so',
  'libstdc++.so', 'libgcc_s.so'
]

export const CHROME_EXECUTABLE = `${BROWSER_ROOT}/bin/chrome-headless-shell`
export const PLAYWRIGHT_MCP_ENTRY = `${BROWSER_ROOT}/js/node_modules/@playwright/mcp/cli.js`

/**
 * What the browser needs in its environment, wherever it is started from.
 *
 * `LD_LIBRARY_PATH` because the libraries are in the volume and not in the
 * image; `FONTCONFIG_PATH` because fontconfig reads an absolute path by default
 * and the image may carry no fonts at all — without it the browser runs, and
 * answers every question about the DOM correctly, but draws no text, so the
 * screenshot that is the point of having it comes back blank.
 */
export function browserEnv(): Record<string, string> {
  return {
    LD_LIBRARY_PATH: `${BROWSER_ROOT}/lib`,
    FONTCONFIG_PATH: `${BROWSER_ROOT}/fontconfig`
  }
}

export function browserVolumeName(arch: string): string {
  const pins = [RUNTIME_IMAGE, BROWSER_PACKAGES.playwright, BROWSER_PACKAGES.mcp, arch].join('\n')
  return `${resourcePrefix()}browser-${createHash('sha256').update(pins).digest('hex').slice(0, 12)}`
}

/**
 * Populate the volume, as root, in a throwaway container of the builder image.
 *
 * The library closure is taken with `ldd` **to a fixed point** and then topped
 * up from the NSS package: one pass is not enough (the binary needs libgobject,
 * which needs libffi, and an image carrying the first but not the second dies
 * at exec), and no number of passes finds the PKCS#11 modules NSS loads with
 * `dlopen` — those are missing until the first page is fetched over TLS, and
 * then it is a fatal `nss_error=-5925`.
 *
 * `.ready` is written last, so an interrupted build is redone.
 */
export function populateScript(): string {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    `ROOT=${BROWSER_ROOT}`,
    'rm -rf "$ROOT"/lib "$ROOT"/fonts "$ROOT"/fontconfig "$ROOT"/js "$ROOT"/browsers "$ROOT"/bin "$ROOT"/.ready',
    'mkdir -p "$ROOT"/lib "$ROOT"/fonts "$ROOT"/fontconfig "$ROOT"/js "$ROOT"/browsers "$ROOT"/bin',
    'apt-get update -qq',
    `apt-get install -y -qq --no-install-recommends ${BROWSER_APT_PACKAGES.join(' ')} >/dev/null`,
    `npm install --prefix "$ROOT/js" --no-fund --no-audit --loglevel=error `
    + `${BROWSER_PACKAGES.playwright} ${BROWSER_PACKAGES.mcp}`,
    'PLAYWRIGHT_BROWSERS_PATH="$ROOT/browsers" '
    + '"$ROOT/js/node_modules/.bin/playwright-core" install --only-shell chromium',
    'SHELL_BIN=$(find "$ROOT/browsers" -name chrome-headless-shell -type f | head -1)',
    '[ -n "$SHELL_BIN" ] || { echo "no headless shell was downloaded" >&2; exit 1; }',
    `ln -sfn "$SHELL_BIN" ${CHROME_EXECUTABLE}`,
    // Copy one library into the volume unless the image has to own it.
    'take() {',
    '  [ -f "$1" ] || return 0',
    '  case "$(basename "$1")" in',
    `    ${IMAGE_OWNED_LIBRARIES.map(name => `${name}*`).join('|')}) return 0 ;;`,
    '  esac',
    '  cp -Ln "$1" "$ROOT/lib/" 2>/dev/null || true',
    '}',
    // The library closure, to a fixed point.
    'for dep in $(ldd "$SHELL_BIN" | awk \'/=> \\//{print $3}\'); do take "$dep"; done',
    'while :; do',
    '  before=$(ls "$ROOT/lib" | wc -l)',
    '  for file in "$ROOT"/lib/*.so*; do ldd "$file" 2>/dev/null | awk \'/=> \\//{print $3}\'; done '
    + '| sort -u > /tmp/deps',
    '  while read -r dep; do take "$dep"; done < /tmp/deps',
    '  [ "$(ls "$ROOT/lib" | wc -l)" = "$before" ] && break',
    'done',
    // NSS loads these with dlopen, so no amount of `ldd` names them.
    'dpkg -L libnss3 | while read -r file; do case "$file" in *.so|*.so.*) take "$file" ;; esac; done',
    'find /usr/share/fonts \\( -name "*.ttf" -o -name "*.otf" \\) '
    + '-exec cp -Ln {} "$ROOT/fonts/" \\; 2>/dev/null || true',
    `cat > "$ROOT/fontconfig/fonts.conf" <<'CONF'\n${fontsConf()}\nCONF`,
    'chmod -R a+rX "$ROOT"',
    // Prove the thing works before calling the volume ready. Both failures this
    // catches are silent: a missing library kills the browser with a bare
    // loader error, and missing fonts leave it rendering nothing at all.
    `cat > /tmp/smoke.mjs <<'SMOKE'\n${smokeScript()}\nSMOKE`,
    `LD_LIBRARY_PATH="$ROOT/lib" FONTCONFIG_PATH="$ROOT/fontconfig" node /tmp/smoke.mjs`,
    // On disk before the marker and after it — see the runtime volume.
    'sync',
    'touch "$ROOT/.ready"',
    'sync'
  ].join('\n')
}

function fontsConf(): string {
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    `  <dir>${BROWSER_ROOT}/fonts</dir>`,
    // The volume is mounted read-only, so the cache cannot live beside the fonts.
    '  <cachedir>/tmp/domo-fontconfig</cachedir>',
    '  <match target="pattern">',
    '    <test qual="any" name="family"><string>sans-serif</string></test>',
    '    <edit name="family" mode="prepend" binding="strong"><string>Liberation Sans</string></edit>',
    '  </match>',
    '</fontconfig>'
  ].join('\n')
}

/**
 * The build's own smoke test: launch, render black text on white, and insist
 * the PNG has ink in it. A blank render of this size compresses to under a
 * kilobyte, and a working one is several — the point is only to tell "drew
 * something" from "drew nothing", which is the failure fonts cause.
 */
function smokeScript(): string {
  return [
    `const { chromium } = await import('${BROWSER_ROOT}/js/node_modules/playwright-core/index.mjs')`,
    `const browser = await chromium.launch({ executablePath: '${CHROME_EXECUTABLE}', `
    + `args: ['--no-sandbox', '--disable-gpu'] })`,
    'const page = await browser.newPage({ viewport: { width: 900, height: 300 } })',
    `await page.setContent('<body style="background:#fff;margin:0">`
    + `<h1 style="color:#000;font:700 40px sans-serif">domo</h1></body>')`,
    'const shot = await page.screenshot()',
    'await browser.close()',
    'if (shot.length < 2000) {',
    '  console.error("the browser rendered a blank page — fonts or fontconfig are missing")',
    '  process.exit(1)',
    '}'
  ].join('\n')
}

let pending: Promise<string> | null = null

/**
 * The shared browser volume. Memoised for the process, so two environments
 * created at once share one build instead of racing through the same volume.
 */
export function ensureBrowserVolume(): Promise<string> {
  pending ??= build().catch((error) => {
    pending = null
    throw error
  })
  return pending
}

async function build(): Promise<string> {
  const volume = browserVolumeName(await dockerServerArch())
  await run('docker', ['volume', 'create', '--label', 'domo.browser=true', volume])
  const ready = await run('docker', [
    'run', '--rm', '--volume', `${volume}:${BROWSER_ROOT}`, RUNTIME_IMAGE,
    // The marker and what it vouches for, as for the runtime volume.
    'sh', '-c', `test -f ${BROWSER_ROOT}/.ready && test -x ${CHROME_EXECUTABLE} && test -s ${BROWSER_ROOT}/fontconfig/fonts.conf`
  ]).then(() => true, () => false)
  if (ready) return volume
  await run('docker', [
    'run', '--rm', '--volume', `${volume}:${BROWSER_ROOT}`, RUNTIME_IMAGE,
    'sh', '-c', populateScript()
  ])
  return volume
}

/** Remove every browser volume but the current one. One still mounted refuses to go. */
export async function collectBrowserVolumes(): Promise<void> {
  const keep = browserVolumeName(await dockerServerArch())
  const { stdout } = await run('docker', [
    'volume', 'ls', '--quiet', '--filter', `name=^${resourcePrefix()}browser-`
  ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
  for (const volume of stdout.split('\n').map(name => name.trim()).filter(Boolean)) {
    if (volume === keep) continue
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
  }
}

/**
 * The `browser` MCP server handed to a coding agent in an environment.
 *
 * Container-only. Every path in it names the two mounted volumes, which exist
 * nowhere on the host — the same host/container split `internalBaseUrl` makes
 * for the mesh URL, and the reason this is a built-in rather than a row in
 * `mcp_servers`, whose commands are written once and used on both sides.
 *
 * `--isolated` keeps the profile in memory: an agent's browser should start
 * from nothing every time rather than accumulate state in a shared volume it
 * cannot write to anyway. `--ignore-https-errors` because the things worth
 * opening from in here — a project's own dev server, Domo behind Caddy — serve
 * certificates from a local CA that nothing in the container trusts.
 */
export function browserMcpServer(): {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string, value: string }>
} {
  return {
    name: 'browser',
    command: `${RUNTIME_ROOT}/node/bin/node`,
    args: [
      PLAYWRIGHT_MCP_ENTRY,
      '--headless',
      '--isolated',
      '--no-sandbox',
      '--ignore-https-errors',
      '--executable-path', CHROME_EXECUTABLE,
      '--output-dir', '/tmp/domo-browser'
    ],
    env: Object.entries(browserEnv()).map(([name, value]) => ({ name, value }))
  }
}
