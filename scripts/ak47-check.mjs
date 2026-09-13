// AK-47 selection, real hitscan damage, full-auto cadence and bot mounts.
// Works against dev and production: only the existing __cs facade is used.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5197';
const out = process.argv[2] || '/tmp/ak47-review';
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
  await page.goto(`${base}/?map=arena&tbots=1&ctbots=1&tweap=ak47&ctweap=ak47&time=600&style=ligne-claire`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__cs);
  await page.click('#playBtn');
  await page.waitForSelector('#colPrimary .wcard');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#colPrimary .wcard')].find(c => c.textContent.includes('AK-47'));
    if (!card) throw new Error('AK-47 missing from primary picker');
    card.click();
  });
  await page.screenshot({ path: `${out}/ak47-selection.png` });
  await page.click('#deployBtn');
  const selected = await page.evaluate(() => ({ name: window.__cs.weapon.name,
    stored: JSON.parse(sessionStorage.getItem('acsc.loadout')), bots: window.__cs.bots.map(b => b.weapon) }));
  assert.equal(selected.name, 'AK-47');
  assert.equal(selected.stored.primary, 'ak47');
  assert.deepEqual(selected.bots, ['ak47', 'ak47']);
  // Reload the page to test the actual persistence boundary.
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__cs);
  assert.equal(await page.evaluate(() => window.__cs.game.primary), 'ak47');
  const mounts = await page.evaluate(() => window.__cs.bots.map(bot => {
    const rig = bot.mesh.getObjectByName('bot-weapon-ak47');
    return !!rig?.getObjectByName('bot-weapon-mechanism-magazine') && !!rig?.getObjectByName('Muzzle');
  }));
  assert.deepEqual(mounts, [true, true]);
  const hits = await page.evaluate(async () => {
    const cs = window.__cs;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    cs.game.started = true; cs.game.locked = true;
    document.getElementById('startMenu').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    for (const bot of cs.bots) { bot.update = () => {}; bot.mesh.visible = false; }
    const target = cs.bots.find(b => b.team === 'T');
    target.mesh.visible = true;
    target.mesh.position.set(12, 0, -15); target.mesh.rotation.y = 0;
    cs.bots.find(b => b.team === 'CT').mesh.position.set(-12, 0, -15);
    cs.player.pos.set(12, cs.player.eyeHeight, -7);
    cs.game.pitch = Math.atan2(2 - cs.player.eyeHeight, 8); cs.game.yaw = 0;
    for (let i = 0; i < 30; i++) await frame();
    const random = Math.random;
    Math.random = () => .5; // Centered scatter isolates hit-zone wiring, not hit probability.
    const results = [];
    try {
      for (let shot = 0; shot < 2; shot++) {
        cs.game.recoil = 0; cs.game.recoilYaw = 0;
        const mag = cs.weapon.mag;
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        const deadline = performance.now() + 10000;
        while (cs.weapon.mag === mag && performance.now() < deadline) await frame();
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        results.push({ hp: target.hp, alive: target.alive, mag: cs.weapon.mag });
        await frame();
      }
    } finally { Math.random = random; }
    cs.game.locked = false;
    return results;
  });
  assert.deepEqual(hits[0], { hp: 40, alive: true, mag: 29 });
  assert.ok(hits[1].hp <= 0);
  assert.equal(hits[1].alive, false);
  assert.equal(hits[1].mag, 28);
  const spray = await page.evaluate(async () => {
    const cs = window.__cs;
    cs.game.pitch = 0.4; cs.game.yaw = 0;
    cs.game.recoil = 0; cs.game.recoilYaw = 0; cs.game.spray = 1;
    cs.game.locked = true;
    const times = [];
    const startMag = cs.weapon.mag;
    let previous = cs.weapon.lastShot;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    const deadline = performance.now() + 20000;
    while (times.length < 10 && performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (cs.weapon.lastShot !== previous) { previous = cs.weapon.lastShot; times.push(previous); }
    }
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    cs.game.locked = false;
    return { times, used: startMag - cs.weapon.mag, recoil: cs.game.recoil, spray: cs.game.spray };
  });
  assert.equal(spray.times.length, 10);
  assert.equal(spray.used, 10, 'Held trigger must fire ten consecutive shots');
  for (let i = 1; i < spray.times.length; i++) {
    const interval = spray.times[i] - spray.times[i - 1];
    assert.ok(interval >= .1 - 1e-9 && interval <= .15 + 1e-6, `Frame-quantized 600 RPM: ${interval}`);
  }
  assert.ok(spray.recoil > 4 && spray.spray > 1.5, 'Sustained fire must accumulate climb and bloom');
  await page.screenshot({ path: `${out}/ak47-sustained.png` });
  const swapped = await page.evaluate(async () => {
    const cs = window.__cs;
    cs.game.recoil = 2; cs.game.recoilYaw = .5; cs.game.spray = 1.5;
    cs.game.locked = true;
    for (const code of ['Digit2', 'Digit1']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    }
    const start = cs.gameTime.now();
    while (cs.gameTime.now() < start + .2) await new Promise(resolve => requestAnimationFrame(resolve));
    cs.game.locked = false;
    return { name: cs.weapon.name, recoil: cs.game.recoil, yaw: cs.game.recoilYaw, spray: cs.game.spray };
  });
  assert.equal(swapped.name, 'AK-47');
  assert.ok(Math.abs(swapped.recoil - 2) < 1e-9 && Math.abs(swapped.yaw - .5) < 1e-9);
  assert.equal(swapped.spray, 1.5, 'Draw delay must freeze carried recoil and spray');
  await page.evaluate(() => {
    const cs = window.__cs;
    for (const bot of cs.bots) bot.respawn();
    const target = cs.bots.find(b => b.team === 'T');
    target.mesh.visible = true; target.mesh.position.set(12, 0, -11); target.mesh.rotation.y = .6;
    cs.player.pos.set(12, cs.player.eyeHeight, -7);
    cs.game.pitch = 0; cs.game.yaw = 0; cs.game.recoil = 0; cs.game.recoilYaw = 0;
    cs.game.locked = true;
  });
  await page.waitForFunction(() => window.__cs.game.recoil === 0);
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.screenshot({ path: `${out}/ak47-bot.png` });
  assert.deepEqual(await page.evaluate(() => window.__cs.bots.map(b => b.weapon)), ['ak47', 'ak47']);
  assert.deepEqual(errors, []);
  console.log('AK-47: picker, persistence, both bot teams, two-headshot kill, sustained cadence/recoil and respawn verified');
} finally { await browser.close(); }
