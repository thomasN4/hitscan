// Real Bot + nav + collision trials, with fixed simulation steps and seeded dice.
// Start Vite first. npm run tune:bots -- --sweep --output /tmp/bot-tuning.json
// The page stays paused; this runner owns updateBots/updateElevators and game time.
import puppeteer from 'puppeteer-core';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { movementRegressions } from './botMovementMetrics.mjs';

const { values } = parseArgs({ options: {
  sweep: { type: 'boolean', default: false },
  validate: { type: 'boolean', default: false },
  output: { type: 'string' },
  config: { type: 'string' },
  candidate: { type: 'string' },
  check: { type: 'boolean', default: false },
  plot: { type: 'string' },
  quick: { type: 'boolean', default: false },
  seeds: { type: 'string', default: '103,211,419' },
} });
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5187';
const validationSeeds = values.seeds.split(',').map(Number);
if (validationSeeds.length !== 3 || validationSeeds.some(s => !Number.isSafeInteger(s) || s < 0 || s > 0xffffffff))
  throw new Error('--seeds requires three unsigned 32-bit integers');
// Recovery must ignore an isolated clamped frame and hand steering back within
// two seconds. These are search bounds, not runtime parameter validation.
const fineBounds = { clearanceWeight: [0, 0.8], lookaheadDistance: [0, 4],
  wallProbeRange: [0.25, 1.5], wallPush: [0, 1], wallSenseCooldown: [0.125, 0.875],
  stuckTime: [0.1, 0.4], commitTime: [0.25, 2] };
const browser = await puppeteer.launch({
  executablePath: process.env.CS_BROWSER || '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: true, protocolTimeout: 300000,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

// Boxes are [x, baseY, z, width, height, depth]. All fixtures use real world registration.
const fixtures = [
  { name: 'parallel', boxes: [[0, 0, 0, 30, 4, 2]], start: [-12, 0, -1.6], goal: [12, 0, -1.6] },
  { name: 'corner', boxes: [[0, 0, 0, 10, 4, 2]], start: [-4, 0, -1.6], goal: [8, 0, 4] },
  { name: 'corner-reverse', boxes: [[0, 0, 0, 10, 4, 2]], start: [8, 0, 4], goal: [-4, 0, -1.6] },
  { name: 'inside-corner', boxes: [[0, 0, 0, 20, 4, 2], [9, 0, 5, 2, 4, 10]], start: [7.4, 0, -1.6], goal: [-13, 0, 4] },
  { name: 'doorway', boxes: [[-6.375, 0, 0, 11.25, 4, 1], [6.375, 0, 0, 11.25, 4, 1]], start: [0, 0, -7], goal: [0, 0, 7] },
  { name: 'corridor', boxes: [[-1.25, 0, 0, 1, 4, 20], [1.25, 0, 0, 1, 4, 20]], start: [0, 0, -8], goal: [0, 0, 8] },
  { name: 'engage-side', engage: true, boxes: [[-1.2, 0, 0, 1, 4, 30]], start: [0, 0, 0], goal: [0, 0, 12] },
  { name: 'engage-back', engage: true, boxes: [[0, 0, -1.2, 30, 4, 1]], start: [0, 0, 0], goal: [0, 0, 4] },
  { name: 'engage-corner', engage: true, boxes: [[-1.2, 0, 0, 1, 4, 30], [0, 0, -1.2, 30, 4, 1]], start: [0, 0, 0], goal: [4, 0, 4] },
  { name: 'engage-open', engage: true, boxes: [], start: [0, 0, 0], goal: [0, 0, 12] },
];

async function setup(page, map = 'arena', synthetic = true, side = 'CT') {
  await page.goto(`${base}/?map=${map}&side=${side.toLowerCase()}&tbots=1&ctbots=0&time=600&lowfx=1`, { waitUntil: 'networkidle0' });
  await page.evaluate(async synthetic => {
    const [state, engine, world, nav, bots, brain, collision, materials, loadouts] = await Promise.all([
      import('/src/core/state.ts'), import('/src/core/engine.ts'), import('/src/world.ts'),
      import('/src/nav.ts'), import('/src/bots.ts'), import('/src/sim/botBrains.ts'),
      import('/src/collision.ts'), import('/src/core/materials.ts'),
      import('/src/sim/botWeapons.ts'),
    ]);
    if (!engine.scene || state.bots !== window.__cs.bots || world.colliders !== window.__cs.colliders)
      throw new Error('Trial imports do not share the running game modules; restart Vite after source changes');
    state.session.locked = false;
    state.session.started = false;
    for (const bot of state.bots) engine.scene.remove(bot.mesh);
    state.bots.length = 0;
    window.movementTrial = { state, engine, world, nav, bots, brain, collision,
      weaponIds: loadouts.BOT_PRIMARY_IDS,
      material: materials.createCelMaterial({ color: 0xaaaaaa }), synthetic,
      fixture: null, weight: null, meshes: [] };
  }, synthetic);
}

async function run(page, config, cases, variants, trace = false) {
  return page.evaluate(({ config, cases, variants, trace }) => {
    const h = window.movementTrial;
    const { state, engine, world, nav, bots, brain, collision } = h;
    const vector = a => state.player.pos.clone().set(...a);
    const results = [];
    for (const fixture of cases) {
      if (h.synthetic && h.fixture !== fixture.name) {
        for (const mesh of h.meshes) engine.scene.remove(mesh);
        h.meshes = [];
        world.resetWorld();
        // Perimeter supplies finite grid bounds and prevents walking around the world.
        for (const box of [...fixture.boxes,
          [0, 0, -24, 49, 4, 1], [0, 0, 24, 49, 4, 1],
          [-24, 0, 0, 1, 4, 48], [24, 0, 0, 1, 4, 48]]) {
          h.meshes.push(world.addSolidBox(...box, h.material));
        }
        h.fixture = fixture.name;
        h.weight = null;
      }
      if (h.weight !== config.clearanceWeight) {
        nav.buildNav(config.clearanceWeight);
        h.weight = config.clearanceWeight;
      }
      for (const variant of variants) {
        let seed = variant.seed >>> 0;
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        const savedRandom = Math.random;
        Math.random = random;
        let bot;
        try {
          // Identical elevator phase for each paired trial, independent of the
          // amount of simulation time earlier candidates happened to consume.
          for (const e of world.elevators) e.elapsed = 0;
          world.updateElevators(0, []);
          const dt = 1 / variant.hz;
          let intendedTotal = 0, actualTotal = 0, lostTotal = 0, movingTime = 0;
          let contactTime = 0, stall = 0, longestStall = 0, routeBuilds = 0;
          let reversals = 0, engageTime = 0, previousDX = 0, previousDZ = 0;
          bot = new bots.Bot(state.opposing(state.session.playerTeam), 'smg', 'pistol', {
            brainParams: { ...brain.DEFAULT_BRAIN_PARAMS, ...config },
            lookaheadDistance: config.lookaheadDistance,
            onRouteBuild: () => { routeBuilds++; },
            onMovement: (intended, actual) => {
              if (intended < 1e-9) { stall = 0; return; }
              intendedTotal += intended; actualTotal += actual;
              lostTotal += Math.max(0, intended - actual); movingTime += dt;
              if (actual < intended * 0.95) contactTime += dt;
              stall = actual < intended * 0.25 ? stall + dt : 0;
              longestStall = Math.max(longestStall, stall);
            },
          });
          state.bots.push(bot);
          // Reset through the public lifecycle: new constructors begin at sound
          // cursor zero, while respawn ignores previous trials' retained sounds.
          bot.respawn();
          bot.speed = variant.speed;
          bot.mesh.position.copy(vector(fixture.start));
          bot.mesh.position.x += variant.offset;
          bot.vy = 0; bot.onGround = true;
          const goal = vector(fixture.goal);
          if (collision.collidesAt(bot.mesh.position, nav.NAV_RADIUS, bot.mesh.position.y, world.colliders)
            || collision.collidesAt(goal, nav.NAV_RADIUS, goal.y, world.colliders)) {
            throw new Error(`Invalid fixture ${fixture.name}: start or goal overlaps geometry`);
          }
          state.player.alive = !!fixture.engage;
          state.player.hp = 1000000;
          state.player.pos.copy(goal).y += state.player.eyeHeight;
          engine.camera.position.copy(state.player.pos);
          bot.mesh.rotation.y = Math.atan2(goal.x - bot.mesh.position.x, goal.z - bot.mesh.position.z);
          if (!fixture.engage) state.soundEvents.emit({ t: state.gameTime.now(), kind: 'gunshot',
            sourceId: 'player', team: state.session.playerTeam, pos: goal, radius: 80 });
          const points = [];
          const maxTime = fixture.engage ? 12 : fixture.transport ? 35 : 24;
          let arrived = false, elapsed = 0;
          let transportSeen = false;
          const startClock = state.gameTime.now();
          for (let frame = 0; frame < Math.ceil(maxTime / dt); frame++) {
            const x = bot.mesh.position.x, z = bot.mesh.position.z;
            state.gameTime.advance(dt);
            world.updateElevators(dt, [{ x, z, feetY: bot.mesh.position.y,
              radius: nav.NAV_RADIUS, height: collision.HEAD_HEIGHT, grounded: bot.onGround }]);
            bots.updateBots(dt, state.player);
            elapsed = state.gameTime.now() - startClock;
            const dx = bot.mesh.position.x - x, dz = bot.mesh.position.z - z;
            if (dx * previousDX + dz * previousDZ < -0.5 * Math.hypot(dx, dz) * Math.hypot(previousDX, previousDZ)) reversals++;
            if (Math.hypot(dx, dz) > 1e-6) { previousDX = dx; previousDZ = dz; }
            if (bot.mode === 'engage') engageTime += dt;
            if (bot.elevatorTrip) transportSeen = true;
            if (trace && frame % Math.max(1, Math.round(variant.hz / 10)) === 0)
              points.push([elapsed, bot.mesh.position.x, bot.mesh.position.y, bot.mesh.position.z, bot.mode]);
            arrived = bot.mesh.position.distanceTo(goal) <= 1.1;
            if (!fixture.engage && arrived) break;
          }
          results.push({ fixture: fixture.name, engage: !!fixture.engage, ...variant,
            arrived: fixture.engage ? null : arrived, elapsed, intendedTotal, actualTotal,
            loss: intendedTotal > 0 ? lostTotal / intendedTotal : 0,
            contactTime, movingTime, longestStall, routeBuilds, reversals, engageTime,
            final: bot.mesh.position.toArray(), transportSeen, points });
        } finally {
          Math.random = savedRandom;
          if (bot) engine.scene.remove(bot.mesh);
          state.bots.length = 0;
        }
      }
    }
    return results;
  }, { config, cases, variants, trace });
}

function summarize(rows) {
  const travel = rows.filter(r => !r.engage);
  const combat = rows.filter(r => r.engage);
  const mean = (rs, key) => rs.length ? rs.reduce((s, r) => s + r[key], 0) / rs.length : 0;
  return {
    failures: travel.filter(r => !r.arrived).length,
    travelTime: mean(travel, 'elapsed'), travelLoss: mean(travel, 'loss'),
    combatLoss: mean(combat, 'loss'), worstStall: Math.max(...rows.map(r => r.longestStall)),
    reversals: mean(rows, 'reversals'),
  };
}

async function population(page, config, seed) {
  return page.evaluate(({ config, seed }) => {
    const { state, world, engine, nav, bots, brain, weaponIds } = window.movementTrial;
    const savedRandom = Math.random;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const totals = { route: { intended: 0, lost: 0, seconds: 0 }, engage: { intended: 0, lost: 0, seconds: 0 } };
    let frameSamples = [];
    try {
      nav.buildNav(config.clearanceWeight);
      state.player.alive = false;
      const dt = 1 / 60;
      for (let i = 0; i < 9; i++) {
        const bot = new bots.Bot(i < 6 ? state.opposing(state.session.playerTeam) : state.session.playerTeam,
          weaponIds[i % weaponIds.length], 'pistol', {
          brainParams: { ...brain.DEFAULT_BRAIN_PARAMS, ...config }, lookaheadDistance: config.lookaheadDistance,
          onMovement: (intended, realized) => frameSamples.push({ bot, intended, realized }),
        });
        bot.respawn();
        bot.hp = 1000000;
        state.bots.push(bot);
      }
      for (let frame = 0; frame < 3600; frame++) {
        state.gameTime.advance(dt);
        world.updateElevators(dt, state.bots.map(b => ({ x: b.mesh.position.x, z: b.mesh.position.z,
          feetY: b.mesh.position.y, radius: nav.NAV_RADIUS, height: 2, grounded: b.onGround })));
        frameSamples = [];
        bots.updateBots(dt, state.player);
        for (const { bot, intended, realized } of frameSamples) {
          const mode = bot.mode === 'patrol' ? 'route' : bot.mode;
          if (!(mode in totals) || intended <= 0) continue;
          totals[mode].intended += intended;
          totals[mode].lost += Math.max(0, intended - realized);
          totals[mode].seconds += dt;
        }
      }
      return totals;
    } finally {
      Math.random = savedRandom;
      for (const bot of state.bots) engine.scene.remove(bot.mesh);
      state.bots.length = 0;
    }
  }, { config, seed });
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  const defaults = await page.evaluate(() => {
    const { nav, bots, brain } = window.movementTrial;
    return { clearanceWeight: nav.CLEARANCE_WEIGHT, lookaheadDistance: bots.LOOKAHEAD_DISTANCE,
      wallProbeRange: brain.DEFAULT_BRAIN_PARAMS.wallProbeRange, wallPush: brain.DEFAULT_BRAIN_PARAMS.wallPush,
      wallSenseCooldown: brain.DEFAULT_BRAIN_PARAMS.wallSenseCooldown,
      stuckTime: brain.DEFAULT_BRAIN_PARAMS.stuckTime, commitTime: brain.DEFAULT_BRAIN_PARAMS.commitTime };
  });
  const initial = { ...defaults, ...JSON.parse(values.config || '{}') };
  const candidateOverrides = JSON.parse(values.candidate || '{}');
  for (const [key, value] of Object.entries({ ...initial, ...candidateOverrides })) {
    if (!(key in defaults) || typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`Invalid tuning parameter ${key}: expected a known, finite, nonnegative number`);
  }
  const variants = [11, 29, 47].map(seed => ({ seed, hz: 60, speed: 3.9, offset: 0 }));
  const records = [];
  const populations = [];
  async function evaluate(config, label, cases = fixtures, samples = variants, trace = false) {
    const rows = await run(page, config, cases, samples, trace);
    const record = { label, config, summary: summarize(rows), rows };
    records.push(record);
    // Retain completed trials even if a later fixture or browser fails.
    if (values.output) await writeFile(values.output, JSON.stringify({ initial, records }, null, 2) + '\n');
    console.log(label, JSON.stringify(config), JSON.stringify(record.summary));
    return record;
  }
  const baseline = await evaluate(initial, 'baseline', fixtures, variants, true);
  let best = baseline;
  if (values.candidate) best = await evaluate({ ...initial, ...candidateOverrides }, 'candidate', fixtures, variants, true);
  // Failed arrivals dominate; collision loss and travel time then share the score.
  const score = r => r.summary.failures * 1000 + r.summary.travelTime
    + 100 * (r.summary.travelLoss + r.summary.combatLoss) + r.summary.worstStall;
  if (values.sweep) {
    const stages = [
      { clearanceWeight: [0, 0.2, 0.4, 0.6, 0.8], lookaheadDistance: [0, 1, 2, 3, 4] },
      { wallProbeRange: [0.5, 0.75, 1, 1.25], wallPush: [0, 0.25, 0.5, 0.75] },
      { wallSenseCooldown: [0.25, 0.5, 0.75] },
      { stuckTime: [0.1, 0.2, 0.25, 0.4], commitTime: [0.25, 0.5, 1, 1.5, 2] },
    ];
    for (const [stage, axes] of stages.entries()) {
      const candidates = Object.entries(axes).reduce((cs, [key, vs]) =>
        cs.flatMap(c => vs.map(v => ({ ...c, [key]: v }))), [best.config]);
      for (const config of candidates) {
        const candidate = await evaluate(config, `stage-${stage + 1}`);
        if (movementRegressions(baseline.rows, candidate.rows).length === 0
          && score(candidate) < score(best) - 1e-6) best = candidate;
      }
    }
    // Two shrinking coordinate sweeps. Each round freezes its centre.
    for (const [round, fraction] of [0.25, 0.125].entries()) {
      const centre = best.config;
      for (const key of Object.keys(defaults)) {
        for (const sign of [-1, 1]) {
          const step = Math.max(defaults[key], centre[key]) * fraction;
          const [lo, hi] = fineBounds[key];
          const value = Math.min(hi, Math.max(lo, centre[key] + sign * step));
          if (value === centre[key]) continue;
          const config = { ...centre, [key]: value };
          const candidate = await evaluate(config, `fine-${round + 1}`);
          if (movementRegressions(baseline.rows, candidate.rows).length === 0
            && score(candidate) < score(best) - 1e-6) best = candidate;
        }
      }
    }
  }
  if (values.validate || values.sweep || values.check) {
    const unseen = validationSeeds.flatMap((seed, i) => [20, 30, 120].map(hz =>
      ({ seed, hz, speed: [3.2, 3.9, 4.6][i], offset: [-0.1, 0.1, 0.15][i] })));
    await evaluate(initial, 'held-out-baseline', fixtures, unseen, true);
    await evaluate(best.config, 'held-out-candidate', fixtures, unseen, true);
    for (const map of ['arena', 'warehouse2', 'elevation']) {
      await setup(page, map, false);
      const cases = map === 'arena' ? [
        { name: 'arena-wall', start: [-25, 0, -1.6], goal: [8, 0, 4] },
        { name: 'arena-wall-reverse', start: [8, 0, 4], goal: [-25, 0, -1.6] },
      ] : map === 'warehouse2' ? [
        { name: 'warehouse-yard-stairs', start: [32.5, 0, 12.5], goal: [32.5, 5.04, 1] },
        { name: 'warehouse-door', start: [0, 0, 25], goal: [0, 0, 17] },
        { name: 'warehouse-rack', start: [-12, 0, -1.4], goal: [20, 0, -6] },
        { name: 'warehouse-rack-reverse', start: [20, 0, -6], goal: [-12, 0, -1.4] },
      ] : [
        { name: 'elevation-stairs', start: [8, 0, 19.5], goal: [8, 3.6, 10] },
      ];
      if (map === 'warehouse2') cases.push(...await page.evaluate(() =>
        window.movementTrial.world.elevators.flatMap(e => [
          { name: `${e.spec.id}-up`, transport: true, start: e.spec.lowerLanding.toArray(), goal: e.spec.upperLanding.toArray() },
          { name: `${e.spec.id}-down`, transport: true, start: e.spec.upperLanding.toArray(), goal: e.spec.lowerLanding.toArray() },
        ])));
      await evaluate(initial, `${map}-baseline`, cases, variants, true);
      await evaluate(best.config, `${map}-candidate`, cases, variants, true);
    }
    for (const map of values.quick ? [] : ['arena', 'warehouse2']) {
      for (const side of ['CT', 'T']) {
        for (const seed of validationSeeds) {
          await setup(page, map, false, side);
          const before = await population(page, initial, seed);
          await setup(page, map, false, side);
          const after = await population(page, best.config, seed);
          populations.push({ map, side, seed, before, after });
          console.log('population', map, side, seed, JSON.stringify({ before, after }));
        }
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const regressions = records.filter(r => r.label.endsWith('candidate')).flatMap(record => {
    const before = records.find(r => r.label === record.label.replace(/candidate$/, 'baseline'));
    if (!before) throw new Error(`Missing baseline for ${record.label}`);
    return movementRegressions(before.rows, record.rows).map(message => `${record.label}: ${message}`);
  });
  const report = { initial, candidate: best.config, regressions, populations, records };
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  if (values.plot) {
    const before = records.find(r => r.label === 'held-out-baseline');
    const after = records.find(r => r.label === 'held-out-candidate');
    if (!before || !after) throw new Error('--plot requires --validate or --sweep');
    const panels = before.rows.filter(r => r.seed === validationSeeds[0] && r.hz === 30).map(a => {
      const b = after.rows.find(r => r.fixture === a.fixture && r.seed === a.seed && r.hz === a.hz);
      const points = [...a.points, ...b.points];
      const minX = Math.min(...points.map(p => p[1])) - 2, maxX = Math.max(...points.map(p => p[1])) + 2;
      const minZ = Math.min(...points.map(p => p[3])) - 2, maxZ = Math.max(...points.map(p => p[3])) + 2;
      const fixture = fixtures.find(f => f.name === a.fixture);
      const boxes = fixture.boxes.map(([x, , z, w, , d]) =>
        `<rect x="${x - w / 2}" y="${z - d / 2}" width="${w}" height="${d}" fill="#d8dce1"/>`).join('');
      const path = (r, color) => `<polyline points="${r.points.map(p => `${p[1]},${p[3]}`).join(' ')}" fill="none" stroke="${color}" stroke-width="0.09"/>`;
      return `<section><h3>${a.fixture}</h3><svg viewBox="${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}" width="330" height="240">${boxes}${path(a, '#566574')}${path(b, '#cf521c')}</svg></section>`;
    }).join('');
    await page.setViewport({ width: 1100, height: 1100 });
    await page.setContent(`<style>body{font:16px sans-serif;background:white}main{display:grid;grid-template-columns:repeat(3,1fr)}h3{margin:10px}section{border:1px solid #ddd}</style><h2>Bot movement: baseline (grey), candidate (orange)</h2><main>${panels}</main>`);
    await page.screenshot({ path: values.plot, fullPage: true });
  }
  console.log('CANDIDATE', JSON.stringify(best.config));
  console.log('REGRESSIONS', JSON.stringify(regressions));
  if (values.check && regressions.length) process.exitCode = 1;
} finally {
  await browser.close();
}
