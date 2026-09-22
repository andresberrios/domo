const ROOT = '/opt/domo-browser'
const { chromium } = await import(`${ROOT}/js/node_modules/playwright-core/index.mjs`)
const b = await chromium.launch({ executablePath: `${ROOT}/bin/chrome-headless-shell`, args: ['--no-sandbox', '--disable-gpu'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 300 } })
const p = await ctx.newPage()
await p.setContent('<body style="background:#fff;margin:0"><h1 style="color:#000;font:700 40px sans-serif">domo</h1></body>')
const ink = (await p.screenshot()).length
let net = 'skipped'
if (process.argv[2]) {
  try {
    const r = await p.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 25000 })
    await p.waitForTimeout(2500)
    const t = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim()
    net = `${r?.status()} ${await p.evaluate(() => performance.getEntriesByType('navigation')[0]?.nextHopProtocol)} len=${t.length}`
  } catch (e) { net = 'ERR ' + String(e.message).slice(0, 50) }
}
console.log(`ink=${ink} text=${ink > 2000 ? 'YES' : 'BLANK'} net=${net}`)
await b.close()
