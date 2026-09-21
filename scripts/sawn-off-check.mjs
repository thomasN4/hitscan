// Input-driven integration coverage; works against Vite dev and production preview.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5199';
const out = process.argv[2] || '/tmp/sawn-off-review';
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  async function advance(seconds) {
    await page.evaluate(async seconds => {
      const cs = window.__cs;
      cs.game.locked = true;
      const until = cs.gameTime.now() + seconds;
      const deadline = performance.now() + 20000;
      while (cs.gameTime.now() < until && performance.now() < deadline)
        await new Promise(resolve => requestAnimationFrame(resolve));
      cs.game.locked = false;
      if (cs.gameTime.now() < until) throw new Error('Game clock did not advance');
    }, seconds);
  }
  async function key(code) {
    await page.evaluate(code => {
      window.__cs.game.locked = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    }, code);
  }
  async function mouse(type, button = 0) {
    await page.evaluate(({ type, button }) => {
      window.__cs.game.locked = true;
      window.dispatchEvent(new MouseEvent(type, { button }));
    }, { type, button });
  }
  async function state() {
    return page.evaluate(() => {
      const cs = window.__cs;
      const vm = cs.bots[0].mesh.parent.getObjectByName('viewmodel-sawnOff');
      return { mag: cs.weapon.mag, reserve: cs.weapon.reserve, reloading: cs.weapon.reloading,
        aiming: cs.game.aiming, hinge: vm.getObjectByName('weapon-mechanism-hinge').rotation.x,
        shells: ['shellLeft', 'shellRight'].map(k => vm.getObjectByName(`weapon-mechanism-${k}`).visible),
        shotAt: cs.weapon.lastShot };
    });
  }
  await page.goto(`${base}/?map=arena&tbots=1&ctbots=1&tsec=sawnOff&ctsec=sawnOff&time=600&style=ligne-claire`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__cs);
  await page.click('#playBtn');
  await page.waitForSelector('#colSecondary .wcard');
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#colSecondary .wcard')];
    const card = cards.find(c => c.textContent.includes('SAWN-OFF'));
    if (!card) throw new Error('Sawn-off missing from sidearm picker');
    if ([...document.querySelectorAll('#colPrimary .wcard')].some(c => c.textContent.includes('SAWN-OFF')))
      throw new Error('Sawn-off appeared as a primary');
    card.click();
  });
  await page.screenshot({ path: `${out}/sawnOff-selection.png` });
  await page.click('#deployBtn');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('acsc.loadout')).secondary), 'sawnOff');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__cs);
  assert.equal(await page.evaluate(() => window.__cs.game.secondary), 'sawnOff');
  // Drain each real primary controller, letting the bot update rebuild its held model.
  const mounts = await page.evaluate(() => {
    const cs = window.__cs;
    cs.game.started = true; cs.game.locked = true;
    cs.player.hp = 100000;
    cs.player.pos.set(12, cs.player.eyeHeight, 10);
    document.getElementById('startMenu').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    return cs.bots.map(bot => {
      const fire = bot.brain.fire;
      for (let i = 0; i < 400 && fire.weapon !== 'sawnOff'; i++) {
        fire.tick(10, true);
        if (fire.weapon !== 'sawnOff' && fire.ready()) fire.pull();
      }
      bot.update(.01, cs.player);
      const rig = bot.mesh.getObjectByName('bot-weapon-sawnOff');
      const result = { weapon: bot.weapon, hinge: !!rig?.getObjectByName('bot-weapon-mechanism-hinge'),
        muzzle: !!rig?.getObjectByName('Muzzle') };
      bot.update = () => {};
      bot.mesh.position.set(bot.team === 'T' ? 12 : -12, 0, -11);
      bot.mesh.rotation.y = .6;
      return result;
    });
  });
  assert.deepEqual(mounts, Array.from({ length: 2 }, () => ({ weapon: 'sawnOff', hinge: true, muzzle: true })));
  await key('Digit2');
  await advance(.5);
  await page.evaluate(() => { window.__cs.player.pos.z = -7; window.__cs.game.pitch = 0; window.__cs.game.yaw = 0; });
  await advance(.1);
  await page.screenshot({ path: `${out}/sawnOff-bot.png` });
  // Center the scatter on a torso to test eight real hitscan rays without RNG flakiness.
  await page.evaluate(() => {
    const cs = window.__cs;
    const target = cs.bots.find(b => b.team === 'T');
    target.mesh.position.set(12, 0, -10); target.mesh.rotation.y = 0; target.hp = 1000;
    cs.game.pitch = Math.atan2(1.2 - cs.player.eyeHeight, 3);
    Math.random = () => .5;
  });
  await advance(.1);
  await mouse('mousedown');
  await advance(.55);
  const first = await state();
  assert.equal(first.mag, 1, 'Holding the trigger must fire exactly one shell');
  assert.equal(await page.evaluate(() => window.__cs.bots.find(b => b.team === 'T').hp), 896);
  await mouse('mouseup'); await advance(.05);
  await page.evaluate(() => { window.__cs.game.recoil = 0; window.__cs.game.recoilYaw = 0; });
  await mouse('mousedown'); await advance(.1);
  const second = await state();
  assert.equal(second.mag, 0);
  assert.ok(second.shotAt - first.shotAt >= .25);
  await advance(.4);
  assert.equal((await state()).reloading, false, 'Held second shot must not auto-reload');
  await mouse('mouseup'); await advance(.05);
  await mouse('mousedown'); await advance(.1); await mouse('mouseup');
  assert.equal((await state()).reloading, true, 'Fresh empty trigger starts reload');
  await advance(2.5);
  assert.equal((await state()).mag, 2);
  assert.equal((await state()).reserve, 14);

  const cadence = await page.evaluate(async () => {
    const cs = window.__cs;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const deadline = performance.now() + 10000;
    async function until(predicate) {
      while (!predicate() && performance.now() < deadline) await frame();
      if (!predicate()) throw new Error('Cadence check timed out');
    }
    const press = type => window.dispatchEvent(new MouseEvent(type, { button: 0 }));
    cs.game.locked = true;
    cs.game.pitch = .5;
    press('mousedown');
    await until(() => cs.weapon.mag === 1);
    const first = cs.weapon.lastShot;
    press('mouseup'); await frame();
    press('mousedown');
    await until(() => cs.gameTime.now() >= first + .20);
    const early = cs.weapon.mag;
    press('mouseup'); await frame();
    await until(() => cs.gameTime.now() >= first + .26);
    press('mousedown');
    await until(() => cs.weapon.mag === 0);
    press('mouseup'); await frame();
    cs.game.locked = false;
    return { early, interval: cs.weapon.lastShot - first };
  });
  assert.equal(cadence.early, 1, 'A fresh click before the firing interval must be refused');
  assert.ok(cadence.interval >= .25 && cadence.interval < .4, 'Second barrel must be available after 0.25 seconds');

  // Every reload case exercises the real R handler and the same end-of-reload transfer.
  for (const [mag, reserve, expected, visible] of [[1, 5, [2, 4], [true, false]], [0, 5, [2, 3], [true, true]], [0, 1, [1, 0], [true, false]]]) {
    await page.evaluate(({ mag, reserve }) => {
      const cs = window.__cs;
      cs.weapon.mag = mag; cs.weapon.reserve = reserve;
      cs.game.pitch = .25; cs.game.recoil = 0; cs.game.recoilYaw = 0;
    }, { mag, reserve });
    await key('KeyR'); await advance(1.2);
    let snap = await state();
    assert.equal(snap.mag, mag, 'Ammo cannot transfer while the breech is open');
    assert.ok(snap.hinge < -.6);
    assert.deepEqual(snap.shells, visible);
    await page.screenshot({ path: `${out}/sawnOff-reload-${mag ? 'partial' : reserve === 1 ? 'limited' : 'full'}.png` });
    await mouse('mousedown', 2); await advance(.1); await mouse('mouseup', 2);
    assert.equal((await state()).aiming, false, 'Aiming is refused during the whole-load reload');
    await mouse('mousedown'); await advance(.1); await mouse('mouseup');
    assert.equal((await state()).mag, mag, 'Firing cannot interrupt an open action');
    await advance(1.2);
    snap = await state();
    assert.deepEqual([snap.mag, snap.reserve], expected);
    assert.equal(snap.reloading, false); assert.ok(Math.abs(snap.hinge) < 1e-9);
    assert.deepEqual(snap.shells, [false, false]);
  }
  // A sprint cancels without transferring; swapping away and back preserves ammunition.
  await page.evaluate(() => { window.__cs.weapon.mag = 1; window.__cs.weapon.reserve = 4; });
  await key('KeyR'); await advance(1.2);
  await page.evaluate(() => {
    window.__cs.game.locked = true;
    for (const code of ['ShiftLeft', 'KeyW']) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  });
  await advance(.3);
  assert.equal((await state()).reloading, false);
  assert.ok(Math.abs((await state()).hinge) < 1e-9);
  assert.deepEqual([(await state()).mag, (await state()).reserve], [1, 4]);
  await page.evaluate(() => {
    for (const code of ['ShiftLeft', 'KeyW']) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  });
  await advance(.2);
  await key('KeyR'); await advance(1.2);
  await key('Digit1'); await key('Digit2'); await advance(.5);
  assert.equal((await state()).reloading, false);
  assert.ok(Math.abs((await state()).hinge) < 1e-9);
  assert.deepEqual((await state()).shells, [false, false]);
  assert.deepEqual([(await state()).mag, (await state()).reserve], [1, 4]);
  // Actual Deploy/respawn callback resets interrupted presentation and both ammo stores.
  await key('KeyR'); await advance(.6);
  await page.evaluate(() => {
    window.__cs.player.alive = false;
    document.getElementById('playBtn').click();
    document.getElementById('deployBtn').click();
  });
  await key('Digit2'); await advance(.5);
  assert.deepEqual([(await state()).mag, (await state()).reserve], [2, 16]);
  assert.ok(Math.abs((await state()).hinge) < 1e-9);
  // Reload on the range replenishes chambers without spending reserve.
  await page.goto(`${base}/?map=range&tbots=1&time=600`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__cs);
  await page.evaluate(() => { window.__cs.game.started = true; window.__cs.game.locked = true; });
  await key('Digit2'); await advance(.5);
  await page.evaluate(() => { window.__cs.weapon.mag = 0; });
  await key('KeyR'); await advance(2.5);
  assert.deepEqual(await page.evaluate(() => [window.__cs.weapon.mag, window.__cs.weapon.reserve]), [2, 16]);
  assert.deepEqual(errors, []);
  console.log('Sawn-off: picker, persistence, both bot mounts, pellets, two clicks, held trigger, empty reload, partial/full/limited reloads, cancellation, respawn and range verified');
} finally { await browser.close(); }
