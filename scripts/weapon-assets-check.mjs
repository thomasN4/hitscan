// Startup failure/retry and independent-clone checks against dev or preview.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5186';
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
try {
  for (const asset of ['shotgun', 'revolver', 'pistol', 'smg', 'sniper', 'knife', 'ak47', 'sawnOff']) for (const failure of ['missing', 'corrupt', 'none']) {
    const page = await browser.newPage();
    let requests = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (!request.url().endsWith(`/assets/${asset}.glb`)) return void request.continue();
      requests++;
      if (failure === 'missing') void request.respond({ status: 404, body: 'Missing' });
      else if (failure === 'corrupt') void request.respond({ status: 200, contentType: 'model/gltf-binary', body: 'broken asset' });
      else void request.continue();
    });
    await page.evaluateOnNewDocument(asset => sessionStorage.setItem('acsc.loadout', JSON.stringify({primary: asset === 'ak47' ? 'ak47' : 'smg', secondary:'pistol'})), asset);
    await page.goto(base + '/?map=arena&tbots=1', { waitUntil: 'networkidle0' });
    if (failure !== 'none') {
      await page.waitForFunction(() => document.getElementById('assetStatus').textContent.includes('Could not load'));
      assert.equal(await page.$eval('#playBtn', b => b.disabled), true);
      assert.equal(await page.evaluate(() => Boolean(window.__cs)), false);
    } else {
      await page.waitForFunction(() => Boolean(window.__cs));
      assert.equal(await page.$eval('#playBtn', b => b.disabled), false);
      // Each viewmodel owns its own nodes: posing one must not move another's.
      const independent = await page.evaluate(asset => {
        const scene = window.__cs.bots[0].mesh.parent;
        const a = scene.getObjectByName(asset === 'ak47' ? 'viewmodel-ak47' : 'viewmodel-smg').getObjectByName('weapon-mechanism-slide');
        const b = scene.getObjectByName('viewmodel-pistol').getObjectByName('weapon-mechanism-slide');
        const before = b.position.clone();
        a.position.z += .4;
        const ok = a !== b && b.position.equals(before);
        a.position.z -= .4;
        return ok;
      }, asset);
      assert.equal(independent, true);
      const pistolRest = asset === 'pistol' ? await page.evaluate(() => {
        const vm = window.__cs.bots[0].mesh.parent.getObjectByName('viewmodel-pistol');
        return ['slide', 'magazine'].map(key => vm.getObjectByName(`weapon-mechanism-${key}`).position.toArray());
      }) : null;
      if (asset === 'pistol') await page.keyboard.press('Digit2');
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
      if (pistolRest) {
        await page.keyboard.press('Digit2');
        await page.waitForFunction(rest => {
          const vm = window.__cs.bots[0].mesh.parent.getObjectByName('viewmodel-pistol');
          return ['slide', 'magazine'].every((key, i) => {
            const position = vm.getObjectByName(`weapon-mechanism-${key}`).position.toArray();
            return position.every((v, axis) => Math.abs(v - rest[i][axis]) < 1e-6);
          });
        }, {}, pistolRest);
      }
      // A cancelled reload must leave finite mechanism transforms behind.
      await page.waitForFunction(asset => {
        const scene = window.__cs.bots[0].mesh.parent;
        let valid = true;
        scene.getObjectByName(asset === 'ak47' ? 'viewmodel-ak47' : 'viewmodel-smg').traverse(node => {
          if (!node.name.startsWith('weapon-mechanism-')) return;
          valid &&= [...node.position.toArray(), ...node.quaternion.toArray()].every(Number.isFinite);
        });
        return valid;
      }, {}, asset);
    }
    assert.equal(requests, 1, 'Asset loads exactly once per page');
    await page.close();
    console.log(`${asset} asset: ${failure} startup verified`);
  }
} finally { await browser.close(); }
