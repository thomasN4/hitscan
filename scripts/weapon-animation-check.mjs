// Real-input animation checks and milestone captures on dev or production.
// CS_SMOKE_BASE=http://127.0.0.1:5180 node scripts/weapon-animation-check.mjs [outDir] [weapon...]
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const BASE = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5178';
const OUT = process.argv[2] || '/tmp/weapon-animation-check';
const ids = process.argv.slice(3);
if (!ids.length) ids.push('smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife');
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const errors = [];
async function runFor(page, seconds) {
  const start = await page.evaluate(() => { window.__cs.game.locked = true; return window.__cs.gameTime.now(); });
  await page.waitForFunction(({ start, seconds }) => window.__cs.gameTime.now() >= start + seconds,
    { timeout: 15000 }, { start, seconds });
}
async function freezeAt(page, time) {
  await page.evaluate(() => { window.__cs.game.locked = true; });
  await page.waitForFunction(time => {
    const cs = window.__cs;
    if (cs.gameTime.now() < time) return false;
    cs.game.locked = false;
    return true;
  }, { timeout: 15000, polling: 'raf' }, time);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const cs = window.__cs;
    const scene = cs.bots[0].mesh.parent;
    const vm = scene.getObjectByName(`viewmodel-${cs.weapon.name.toLowerCase()}`);
    const parts = {};
    const camera = scene.children.find(node => node.isCamera);
    let forearmsOffscreen = true;
    vm.traverse(node => {
      if (node.name.startsWith('weapon-forearm-')) {
        const elbow = node.position.clone().set(0, -0.5, 0);
        node.localToWorld(elbow); elbow.project(camera);
        forearmsOffscreen &&= elbow.y < -1;
      }
      if (node.name.startsWith('weapon-mechanism-') || node.name.endsWith('-hand')) {
        parts[node.name] = { position: node.position.toArray(), rotation: node.rotation.toArray().slice(0, 3), visible: node.visible };
      }
    });
    return { parts, forearmsOffscreen, mag: cs.weapon.mag, reserve: cs.weapon.reserve, reloading: cs.weapon.reloading };
  });
}
async function trigger(page) {
  const before = await page.evaluate(() => window.__cs.weapon.lastShot);
  await page.evaluate(() => { window.__cs.game.locked = true; window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })); });
  await page.waitForFunction(before => window.__cs.weapon.lastShot > before, { timeout: 12000 }, before);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
  return page.evaluate(() => window.__cs.weapon.lastShot);
}
try {
  for (const id of ids) {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
    await page.evaluateOnNewDocument(id => sessionStorage.setItem('acsc.loadout', JSON.stringify({
      primary: ['smg', 'sniper', 'shotgun'].includes(id) ? id : 'smg',
      secondary: id === 'revolver' ? 'revolver' : 'pistol',
    })), id);
    await page.goto(`${BASE}/?map=arena&tbots=1&time=600&style=${process.env.CS_SMOKE_STYLE || 'ligne-claire'}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const cs = window.__cs;
      cs.game.started = true; cs.game.locked = true;
      cs.player.pos.set(6, 1.7, 10); cs.game.yaw = -2.35;
      for (const bot of cs.bots) { bot.update = () => {}; bot.mesh.visible = false; }
      document.getElementById('startMenu').style.display = 'none';
      document.getElementById('hud').style.display = 'block';
    });
    if (['pistol', 'revolver'].includes(id)) await page.keyboard.press('Digit2');
    if (id === 'knife') await page.keyboard.press('Digit3');
    await runFor(page, 0.35);
    assert.equal(await page.evaluate(() => window.__cs.weapon.name.toLowerCase()), id);
    const idle = await snapshot(page);
    assert.ok(idle.forearmsOffscreen, `${id}: forearm ends visible at rest`);
    assert.ok(idle.parts['right-hand'] && idle.parts['left-hand']);
    if (idle.parts['weapon-mechanism-shell']) assert.equal(idle.parts['weapon-mechanism-shell'].visible, false);
    await page.screenshot({ path: `${OUT}/${id}-hip.png` });
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 2 })));
    if (id !== 'knife') await page.waitForFunction(() => window.__cs.game.adsLerp > 0.995);
    await page.screenshot({ path: `${OUT}/${id}-ads.png` });
    if (id === 'revolver') {
      const hammerTop = await page.evaluate(() => {
        const scene = window.__cs.bots[0].mesh.parent;
        const camera = scene.children.find(node => node.isCamera);
        const hammer = scene.getObjectByName('viewmodel-revolver').getObjectByName('weapon-mechanism-hammer');
        let top = -Infinity;
        hammer.traverse(node => {
          if (node.name !== 'weapon-part') return;
          const positions = node.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) {
            const point = node.position.clone().fromBufferAttribute(positions, i);
            node.localToWorld(point); point.project(camera); top = Math.max(top, point.y);
          }
        });
        return top;
      });
      assert.ok(hammerTop < -0.005, `Hammer blocks sight line: NDC top ${hammerTop}`);
    }
    if (id === 'sniper') {
      await trigger(page);
      assert.equal(await page.evaluate(() => window.__cs.game.aiming), false);
      await runFor(page, 1.2);
    }
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })));
    await page.waitForFunction(() => window.__cs.game.adsLerp < 0.005);
    const shotAt = await trigger(page);
    const interval = await page.evaluate(() => window.__cs.weapon.fireRate);
    await freezeAt(page, shotAt + interval * (id === 'pistol' ? 0.3 : 0.4));
    const fired = await snapshot(page);
    if (id === 'shotgun') assert.ok(fired.parts['weapon-mechanism-pump'].position[2] > idle.parts['weapon-mechanism-pump'].position[2] + 0.06);
    if (id === 'sniper') assert.ok(fired.parts['weapon-mechanism-bolt'].position[2] > idle.parts['weapon-mechanism-bolt'].position[2] + 0.04);
    await page.screenshot({ path: `${OUT}/${id}-fire.png` });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await snapshot(page), fired, 'Pause must freeze hands, mechanisms and ammo');
    await runFor(page, interval + 0.1);

    if (id !== 'knife') {
      const perRound = ['shotgun', 'revolver'].includes(id);
      await page.evaluate(() => { window.__cs.weapon.mag = window.__cs.weapon.magSize - 2; });
      await page.keyboard.press('KeyR');
      const schedule = await page.evaluate(() => {
        const w = window.__cs.weapon;
        const duration = w.nextRoundAt > 0 ? w.reloadTime / w.magSize : w.reloadTime;
        return { start: (w.nextRoundAt > 0 ? w.nextRoundAt : w.reloadEnd) - duration, duration };
      });
      for (const [label, fraction] of [['open', 0.18], ['insert', 0.5], ['seat', 0.80]]) {
        await freezeAt(page, schedule.start + schedule.duration * fraction);
        const pose = await snapshot(page);
        assert.ok(pose.forearmsOffscreen, `${id}: forearm ends visible during reload`);
        if (label === 'insert' && perRound) assert.equal(pose.parts['weapon-mechanism-shell'].visible, true);
        if (label === 'insert' && id === 'revolver') assert.ok(pose.parts['weapon-mechanism-cylinder'].position[0] < idle.parts['weapon-mechanism-cylinder'].position[0] - 0.03);
        await page.screenshot({ path: `${OUT}/${id}-reload-${label}.png` });
      }
      if (perRound) {
        await freezeAt(page, schedule.start + schedule.duration * 1.16);
        const transferred = await snapshot(page);
        assert.equal(transferred.mag, idle.mag - 1);
        assert.ok(transferred.reloading);
        if (id === 'revolver') assert.ok(transferred.parts['weapon-mechanism-cylinder'].position[0] < idle.parts['weapon-mechanism-cylinder'].position[0] - 0.03);
        await trigger(page);
        const interrupted = await snapshot(page);
        assert.equal(interrupted.reloading, false);
        assert.equal(interrupted.mag, idle.mag - 2);
        assert.equal(interrupted.parts['weapon-mechanism-shell'].visible, false);
        if (id === 'revolver') assert.deepEqual(interrupted.parts['weapon-mechanism-cylinder'].position, idle.parts['weapon-mechanism-cylinder'].position);
        await runFor(page, interval + 0.1);
      } else await runFor(page, schedule.duration);
      // Empty reload exercises charge gestures and every chamber/shell transfer.
      await page.evaluate(() => { window.__cs.weapon.mag = 0; window.__cs.weapon.reserve = window.__cs.weapon.magSize; });
      await page.keyboard.press('KeyR');
      await runFor(page, await page.evaluate(() => window.__cs.weapon.reloadTime + 0.3));
      const full = await snapshot(page);
      assert.equal(full.reloading, false); assert.equal(full.mag, idle.mag); assert.equal(full.reserve, 0);
      if (full.parts['weapon-mechanism-shell']) assert.equal(full.parts['weapon-mechanism-shell'].visible, false);
      await page.screenshot({ path: `${OUT}/${id}-restored.png` });
      // One remaining reserve round must close the per-round mechanism cleanly.
      if (perRound) {
        await page.evaluate(() => { window.__cs.weapon.mag = 1; window.__cs.weapon.reserve = 1; });
        await page.keyboard.press('KeyR');
        await runFor(page, schedule.duration + 0.2);
        const dry = await snapshot(page);
        assert.equal(dry.mag, 2); assert.equal(dry.reserve, 0); assert.equal(dry.reloading, false);
      }
      // Swap out during a reload and rapidly return; no stale mechanism or props.
      await page.evaluate(() => { window.__cs.weapon.mag = 1; window.__cs.weapon.reserve = 3; });
      await page.keyboard.press('KeyR'); await runFor(page, 0.1);
      await page.keyboard.press('Digit3');
      await page.keyboard.press(['pistol', 'revolver'].includes(id) ? 'Digit2' : 'Digit1');
      await runFor(page, 0.3);
      const swapped = await snapshot(page);
      assert.equal(swapped.reloading, false);
      if (swapped.parts['weapon-mechanism-shell']) assert.equal(swapped.parts['weapon-mechanism-shell'].visible, false);
    }
    console.log(`${id}: ${id === 'knife' ? 'hip/ADS, swing and pause' : 'sights, shot cycle, pause, reload milestones, ammo and interruption'} checked`);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser errors or shader warnings');
} finally { await browser.close(); }
