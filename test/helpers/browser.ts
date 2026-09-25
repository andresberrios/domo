import { chromium, type Browser, type Page } from 'playwright-core'

/**
 * The one Chromium the voice-live layer drives, and where it comes from.
 *
 * Playwright's own download is the default, so a developer who has run
 * `npx playwright install chromium` needs nothing here. `DOMO_TEST_CHROMIUM`
 * overrides the executable for an environment that already has one — a Domo
 * dev environment mounts a shared browser at `/opt/domo-browser`, and pulling
 * a second several-hundred-megabyte copy into every container to run these
 * tests would be silly.
 */
export function chromiumPath(): string | undefined {
  return process.env.DOMO_TEST_CHROMIUM || undefined
}

/**
 * **A Chromium with no fontconfig dies the moment it renders text**, and the
 * way it dies is worth knowing because it looks like anything but a font
 * problem: the browser disconnects a second after `page.goto` resolves, every
 * locator then fails with "Target page, context or browser has been closed",
 * and the only hint is one line on the browser's own stderr —
 * `FATAL: SkFontMgr_FontConfigInterface … Not implemented`, after a quiet
 * `Fontconfig error: Cannot load default config file`. A trivial page survives
 * it; the real app does not, because the real app draws words.
 *
 * In a Domo dev environment the bundled browser supplies both itself, because
 * `bin/chrome-headless-shell` is a wrapper rather than a symlink (see
 * `server/lib/dev-env/browser-volume.ts`). So one variable is enough, and it
 * must point at the **wrapper**, not at the binary under `browsers/`:
 *
 * ```sh
 * export DOMO_TEST_CHROMIUM=/opt/domo-browser/bin/chrome-headless-shell
 * ```
 *
 * Do not set `LD_LIBRARY_PATH` yourself. Playwright's own Chromium loads the
 * wrong libraries from it and exits 127, and the wrapper does not need help.
 */

/**
 * Launch a browser whose microphone is a WAV file.
 *
 * **One browser per spoken question, and that is not laziness**: the audio
 * source is a *launch* flag, so it cannot be changed on a running browser, nor
 * per context or page. Chromium loops the file for as long as the microphone
 * is open, which is why the questions these tests ask are one short sentence —
 * the model hears it again every few seconds until the mic stops.
 *
 * The other flags are load-bearing too. The fake device is what makes
 * `getUserMedia` resolve without hardware or a permission prompt; autoplay has
 * to be waived because playback starts from a WebSocket message rather than a
 * click; and `--no-sandbox` is for running as root in a container.
 */
export async function launchBrowser(audioFile?: string): Promise<Browser> {
  return chromium.launch({
    executablePath: chromiumPath(),
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}`] : []),
      '--autoplay-policy=no-user-gesture-required'
    ]
  })
}

/**
 * A page with its console and page errors forwarded to the test's stderr.
 *
 * Without this a failure in the app renders as a poll timing out on text that
 * never appeared, with the actual cause — an unhandled rejection in
 * `useVoiceChannel`, a CSP refusal, a failed dynamic import — visible only
 * inside the browser. These tests fail rarely and opaquely; the noise is worth
 * it.
 */
export async function openPage(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser console] ${message.text()}`)
  })
  page.on('pageerror', error => console.error(`[browser error] ${error.message}`))
  await page.goto(url)
  return page
}
