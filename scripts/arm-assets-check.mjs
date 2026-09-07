// Startup failure/retry and independent skeleton checks against dev or preview.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5186';
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
try {
  for (const failure of ['missing', 'corrupt', 'none']) {
    const page = await browser.newPage();
    let requests = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (!request.url().endsWith('/assets/arms.glb')) return void request.continue();
      requests++;
      if (failure === 'missing') void request.respond({ status: 404, body: 'Missing' });
      else if (failure === 'corrupt') void request.respond({ status: 200, contentType: 'model/gltf-binary', body: 'broken asset' });
      else void request.continue();
    });
    await page.goto(base + '/?map=arena&tbots=1', { waitUntil: 'networkidle0' });
    if (failure !== 'none') {
      await page.waitForFunction(() => document.getElementById('assetStatus').textContent.includes('Could not load'));
      assert.equal(await page.$eval('#playBtn', b => b.disabled), true);
      assert.equal(await page.evaluate(() => Boolean(window.__cs)), false);
    } else {
      await page.waitForFunction(() => Boolean(window.__cs));
      assert.equal(await page.$eval('#playBtn', b => b.disabled), false);
      const independent = await page.evaluate(() => {
        const scene = window.__cs.bots[0].mesh.parent;
        const a = scene.getObjectByName('viewmodel-smg').getObjectByName('right-hand');
        const b = scene.getObjectByName('viewmodel-pistol').getObjectByName('right-hand');
        const before = b.quaternion.clone();
        a.rotation.x += .4;
        const ok = a !== b && b.quaternion.equals(before);
        a.rotation.x -= .4;
        return ok;
      });
      assert.equal(independent, true);
      await page.evaluate(() => {
        const cs = window.__cs;
        cs.game.started = true; cs.game.locked = true;
        cs.weapon.mag = 1;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      });
      await page.waitForFunction(() => window.__cs.weapon.reloading);
      // Exercise the actual menu Deploy callback's dead-player respawn branch.
      await page.evaluate(() => {
        window.__cs.player.alive = false;
        document.getElementById('playBtn').click();
        document.getElementById('deployBtn').click();
      });
      await page.waitForFunction(() => window.__cs.player.alive && !window.__cs.weapon.reloading);
      await page.evaluate(() => { window.__cs.game.locked = true; });
      await page.waitForFunction(() => {
        const scene = window.__cs.bots[0].mesh.parent;
        let valid = true;
        scene.getObjectByName('viewmodel-smg').traverse(node => {
          if (node.isBone) valid &&= [...node.position.toArray(), ...node.quaternion.toArray()].every(Number.isFinite);
        });
        return valid;
      });
    }
    assert.equal(requests, 1, 'Asset loads exactly once per page');
    await page.close();
    console.log(`Arm assets: ${failure} startup verified`);
  }
} finally { await browser.close(); }
