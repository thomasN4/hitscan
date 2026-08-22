import puppeteer from 'puppeteer-core';

const BRAVE = '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave';

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));

  const hook = await page.evaluate(() => !!window.__cs);
  const canvas = await page.evaluate(() => !!document.querySelector('canvas'));
  console.log('module loaded:', { hook, canvas });
  console.log('errors so far:', JSON.stringify(errors, null, 2));

  if (hook) {
    await page.evaluate(() => {
      window.__cs.game.started = true;
      window.__cs.game.locked = true;
      window.__cs.weapon.mag = 10;
    });
    await page.keyboard.press('KeyR');
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(() => ({
      mag: window.__cs.weapon.mag,
      reloading: window.__cs.weapon.reloading,
      reserve: window.__cs.weapon.reserve,
    }));
    console.log('after R:', JSON.stringify(after));
    await new Promise(r => setTimeout(r, 2300));
    const done = await page.evaluate(() => ({
      mag: window.__cs.weapon.mag,
      reloading: window.__cs.weapon.reloading,
      reserve: window.__cs.weapon.reserve,
    }));
    console.log('after reload window:', JSON.stringify(done));
  }
} catch (e) {
  console.log('test exception:', e.message);
}
console.log('console/page errors:', JSON.stringify(errors, null, 2));
await browser.close();
