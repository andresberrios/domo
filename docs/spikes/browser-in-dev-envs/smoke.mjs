const ROOT = '/opt/domo-browser'
process.env.LD_LIBRARY_PATH = `${ROOT}/lib`
process.env.FONTCONFIG_PATH = `${ROOT}/fontconfig`
const { chromium } = await import(`${ROOT}/js/node_modules/playwright-core/index.mjs`)
const b = await chromium.launch({
  executablePath: `${ROOT}/bin/chrome-headless-shell`,
  args: ['--no-sandbox', '--disable-gpu']
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 300 } })
const p = await ctx.newPage()
// 1. does it render text at all (fonts + fontconfig)
await p.setContent('<body style="background:#fff;margin:0"><h1 style="color:#000;font:700 40px sans-serif">Domo browser OK</h1></body>')
const shot = await p.screenshot()
const nonWhite = shot.length
// 2. does TLS work (NSS dlopen modules)
let net = 'skipped'
if (process.argv[2]) {
  const r = await p.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 25000 })
  await p.waitForTimeout(3000)
  const text = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim()
  net = `${r?.status()} proto=${await p.evaluate(() => performance.getEntriesByType('navigation')[0]?.nextHopProtocol)} len=${text.length}`
  await p.screenshot({ path: `/out/smoke-${process.argv[3] || 'x'}.png` })
}
// crude ink check: a blank PNG of this size compresses far smaller
console.log(JSON.stringify({ image: process.argv[3], pngBytes: nonWhite, rendersText: nonWhite > 2000, net }))
await b.close()
