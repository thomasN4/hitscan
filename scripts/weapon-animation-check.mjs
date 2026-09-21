// Real-input animation checks and milestone captures on dev or production.
// CS_SMOKE_BASE=http://127.0.0.1:5180 node scripts/weapon-animation-check.mjs [outDir] [weapon...]
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const BASE = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5178';
const OUT = process.argv[2] || '/tmp/weapon-animation-check';
const ids = process.argv.slice(3);
if (!ids.length) ids.push('smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife', 'ak47', 'sawnOff');
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
    const vm = scene.getObjectByName(`viewmodel-${(cs.weapon.name === 'SAWN-OFF' ? 'sawnOff' : cs.weapon.name.toLowerCase().replaceAll('-', ''))}`);
    const parts = {};
    vm.traverse(node => {
      if (node.name.startsWith('weapon-mechanism-')) {
        parts[node.name] = { position: node.position.toArray(), rotation: node.rotation.toArray().slice(0, 3), visible: node.visible };
      }
    });
    return { parts, mag: cs.weapon.mag, reserve: cs.weapon.reserve, reloading: cs.weapon.reloading };
  });
}
/** The weapon rig's pose in CAMERA space: the two translations and the two
 * rotations that can slide the sights off screen centre. Deliberately not a
 * projected bounding box — the depth punch on z is kept, and a box is dominated
 * by it (and by stock vertices near the near plane), so a box cannot tell a
 * legitimate 2 cm depth punch from the sights actually walking off the crosshair. */
async function aimRig(page, id) {
  return page.evaluate(id => {
    const rig = window.__cs.bots[0].mesh.parent.getObjectByName(`viewmodel-${id}`).parent;
    return [rig.position.x, rig.position.y, rig.rotation.x, rig.rotation.y];
  }, id);
}

/** Every mechanism transform is a real number: a pose that divides by zero or
 * normalizes a zero-length vector shows up here rather than as an invisible gun. */
function finite(snap) {
  return Object.values(snap.parts).every(part =>
    [...part.position, ...part.rotation].every(Number.isFinite));
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
      primary: ['smg', 'sniper', 'shotgun', 'ak47'].includes(id) ? id : 'smg',
      secondary: ['revolver', 'sawnOff'].includes(id) ? id : 'pistol',
    })), id);
    await page.goto(`${BASE}/?map=arena&tbots=1&time=600&style=${process.env.CS_SMOKE_STYLE || 'ligne-claire'}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const cs = window.__cs;
      cs.game.started = true; cs.game.locked = true;
      cs.player.pos.set(6, 1.6, 10); cs.game.yaw = -2.35;
      for (const bot of cs.bots) { bot.update = () => {}; bot.mesh.visible = false; }
      document.getElementById('startMenu').style.display = 'none';
      document.getElementById('hud').style.display = 'block';
    });
    if (['pistol', 'revolver', 'sawnOff'].includes(id)) await page.keyboard.press('Digit2');
    if (id === 'knife') await page.keyboard.press('Digit3');
    await runFor(page, 0.45);
    assert.equal(await page.evaluate(() => (window.__cs.weapon.name === 'SAWN-OFF' ? 'sawnOff' : window.__cs.weapon.name.toLowerCase().replaceAll('-', ''))), id);
    const idle = await snapshot(page);
    if (idle.parts['weapon-mechanism-shell']) assert.equal(idle.parts['weapon-mechanism-shell'].visible, false);
    await page.screenshot({ path: `${OUT}/${id}-hip.png` });
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 2 })));
    if (id !== 'knife') await page.waitForFunction(() => window.__cs.game.adsLerp > 0.995);
    await page.screenshot({ path: `${OUT}/${id}-ads.png` });
    if (id !== 'knife') {
      // Aiming is a sight picture: the camera may kick, the weapon may not move
      // relative to screen centre. Recoil is set directly rather than fired so
      // this measures the transform, not a weapon's fire rate; bob has to be
      // earned by walking, because updateMovement recomputes bobAmt every frame.
      const aimed = await aimRig(page, id);
      await page.keyboard.down('KeyW');
      await page.evaluate(() => { window.__cs.game.recoil = 6; window.__cs.game.recoilYaw = 3; });
      await runFor(page, 0.3);
      assert.ok(await page.evaluate(() => window.__cs.game.bobAmt > 0), `${id}: walk never produced bob`);
      const kicked = await aimRig(page, id);
      const drift = Math.max(...kicked.map((v, i) => Math.abs(v - aimed[i])));
      // Not zero: adsLerp approaches 1 asymptotically, so (1 - ads) leaves a
      // residual around 1e-4 rad. 5e-4 rad is 0.03 degrees, half a millimetre at
      // the sight, and still 60x below the ~0.03 rad the ungated kick produces.
      assert.ok(drift < 5e-4, `${id}: aimed rig moved ${drift.toExponential(2)} under recoil and bob`);
      await page.keyboard.up('KeyW');
      await page.evaluate(() => { window.__cs.game.recoil = 0; window.__cs.game.recoilYaw = 0; });
      await runFor(page, 0.2);
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
    if (id === 'pistol') assert.ok(fired.parts['weapon-mechanism-slide'].position[2] > idle.parts['weapon-mechanism-slide'].position[2] + .003, 'Pistol slide must cycle');
    await page.screenshot({ path: `${OUT}/${id}-fire.png` });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await snapshot(page), fired, 'Pause must freeze mechanisms and ammo');
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
        assert.ok(finite(pose), `${id}: non-finite mechanism transform during reload`);
        if (label === 'insert' && perRound) assert.equal(pose.parts['weapon-mechanism-shell'].visible, true);
        if (label === 'insert' && id === 'revolver') assert.ok(pose.parts['weapon-mechanism-cylinder'].rotation[2] > idle.parts['weapon-mechanism-cylinder'].rotation[2] + 1.4);
        if (id === 'smg' || id === 'ak47' || id === 'sniper') {
          const rest = idle.parts['weapon-mechanism-magazine'].position;
          const mag = pose.parts['weapon-mechanism-magazine'].position;
          assert.ok(Math.abs(mag[0]-rest[0]) < 1e-6 && Math.abs(mag[2]-rest[2]) < 1e-6, 'Rifle magazine must follow its vertical well');
          if (label === 'insert') assert.ok(mag[1]-rest[1] < (id === 'smg' ? -.23 : -.17), 'Magazine must clear the well');
          if (label === 'seat') assert.ok(Math.hypot(...mag.map((v,i)=>v-rest[i])) < 1e-6, 'Magazine must reseat');
        }
        if (id === 'pistol') {
          const rest = idle.parts['weapon-mechanism-magazine'].position;
          const mag = pose.parts['weapon-mechanism-magazine'].position;
          const dy = mag[1] - rest[1], dz = mag[2] - rest[2];
          assert.ok(Math.abs(dz + .32 * dy) < 1e-6, 'Magazine must track the grip slope');
          if (label === 'insert') assert.ok(dy < -.17 && dz > .05, 'Magazine must clear the well');
          if (label === 'seat') assert.ok(Math.hypot(...mag.map((v,i)=>v-rest[i])) < 1e-6, 'Magazine must reseat');
          assert.deepEqual(pose.parts['weapon-mechanism-slide'].position, idle.parts['weapon-mechanism-slide'].position, 'Partial reload must not rack the slide');
        }
        await page.screenshot({ path: `${OUT}/${id}-reload-${label}.png` });
      }
      if (perRound) {
        await freezeAt(page, schedule.start + schedule.duration * 1.16);
        const transferred = await snapshot(page);
        assert.equal(transferred.mag, idle.mag - 1);
        assert.ok(transferred.reloading);
        if (id === 'revolver') assert.ok(transferred.parts['weapon-mechanism-cylinder'].rotation[2] > idle.parts['weapon-mechanism-cylinder'].rotation[2] + 1.4);
        await trigger(page);
        const interrupted = await snapshot(page);
        assert.equal(interrupted.reloading, false);
        assert.equal(interrupted.mag, idle.mag - 2);
        assert.equal(interrupted.parts['weapon-mechanism-shell'].visible, false);
        if (id === 'revolver') assert.deepEqual(interrupted.parts['weapon-mechanism-cylinder'].rotation, idle.parts['weapon-mechanism-cylinder'].rotation);
        await runFor(page, interval + 0.1);
      } else await runFor(page, schedule.duration);
      // Empty reload exercises charge gestures and every chamber/shell transfer.
      await page.evaluate(() => { window.__cs.weapon.mag = 0; window.__cs.weapon.reserve = window.__cs.weapon.magSize; });
      await page.keyboard.press('KeyR');
      if (id === 'pistol') {
        const chargeAt = await page.evaluate(() => window.__cs.weapon.reloadEnd - window.__cs.weapon.reloadTime * .14);
        await freezeAt(page, chargeAt);
        const charged = await snapshot(page);
        assert.ok(charged.parts['weapon-mechanism-slide'].position[2] > idle.parts['weapon-mechanism-slide'].position[2] + .04);
        const mag = charged.parts['weapon-mechanism-magazine'].position;
        assert.ok(Math.hypot(...mag.map((v,i)=>v-idle.parts['weapon-mechanism-magazine'].position[i])) < 1e-6);
        await page.screenshot({ path: `${OUT}/${id}-empty-charge.png` });
      }
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
      await page.keyboard.press(['pistol', 'revolver', 'sawnOff'].includes(id) ? 'Digit2' : 'Digit1');
      // A fresh draw blocks reload for the full 0.4-second deploy window.
      await runFor(page, 0.5);
      const swapped = await snapshot(page);
      assert.equal(swapped.reloading, false);
      if (['pistol','smg','sniper','ak47'].includes(id)) {
        // Sprint still cancels a running reload CS-style; ADS is refused
        // instead — RMB mid-reload neither cancels it nor raises the sights.
        await page.keyboard.press('KeyR'); await runFor(page, .5);
        await page.mouse.down({button:'right'});
        await runFor(page, .4);
        const aimed = await snapshot(page);
        assert.equal(aimed.reloading, true);
        assert.equal(await page.evaluate(() => window.__cs.game.aiming), false);
        await page.mouse.up({button:'right'});
        await runFor(page, .4);
        await page.keyboard.press('KeyR'); await runFor(page, .5);
        await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
        await runFor(page, .4);
        const cancelled = await snapshot(page);
        assert.equal(cancelled.reloading, false);
        for (const key of [id === 'sniper' ? 'bolt' : 'slide', 'magazine']) {
          const rest = idle.parts[`weapon-mechanism-${key}`].position;
          const actual = cancelled.parts[`weapon-mechanism-${key}`].position;
          assert.ok(Math.hypot(...actual.map((v,i)=>v-rest[i])) < 1e-6, `sprint cancellation must restore ${key}`);
        }
        await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
        await runFor(page, .4);
      }
      if (swapped.parts['weapon-mechanism-shell']) assert.equal(swapped.parts['weapon-mechanism-shell'].visible, false);
    }
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await runFor(page, .5);
    assert.ok(finite(await snapshot(page)), `${id}: non-finite mechanisms while sprinting`);
    await page.screenshot({ path: `${OUT}/${id}-sprint.png` });
    await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
    await runFor(page, .3);
    await page.keyboard.press(id === 'knife' ? 'Digit1' : 'Digit3');
    await runFor(page, .1);
    await page.keyboard.press(id === 'knife' ? 'Digit3' : ['pistol', 'revolver', 'sawnOff'].includes(id) ? 'Digit2' : 'Digit1');
    await runFor(page, .1);
    assert.ok(finite(await snapshot(page)), `${id}: non-finite mechanisms after a swap`);
    await page.screenshot({ path: `${OUT}/${id}-swap.png` });
    console.log(`${id}: ${id === 'knife' ? 'hip/ADS, swing and pause' : 'sights, shot cycle, pause, reload milestones, ammo and interruption'} checked`);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser errors or shader warnings');
} finally { await browser.close(); }
