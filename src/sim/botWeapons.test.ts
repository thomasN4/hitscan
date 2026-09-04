import { describe, expect, test } from 'vitest';
import {
  BOT_WEAPON_IDS,
  BOT_WEAPON_TUNING,
  FIRST_SHOT_DELAY_MIN,
  FIRST_SHOT_DELAY_SPAN,
  WeaponFireController,
  botBrainParams,
  botHitChance,
  resolveBotWeapon,
  type BotWeaponTuning,
  type FireController,
} from './botWeapons';
import { DEFAULT_BRAIN_PARAMS } from './botBrains';
import { damageForPart } from './damage';
import { WEAPONS, type BotWeaponId } from '../core/state';

const DT = 1 / 60;

/** `n` copies of `v` — Array(n).fill(v) infers any[] under the no-unsafe rules. */
function repeat(n: number, v: number): number[] {
  return Array.from({ length: n }, () => v);
}

/**
 * A scripted rng: consumes `values` in order, then falls back permanently to
 * 0.999 — a draw that never lands a hit and always takes the longest pause,
 * so an unscripted tail cannot accidentally satisfy a claim. Same device (and
 * same reasoning) as botBrains.test.ts's queueRng.
 */
function queueRng(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++]! : 0.999);
}

/** A controller over the REAL catalog def, so the tests bind to shipped stats. */
function controller(
  id: BotWeaponId,
  rng: () => number,
  tuning: BotWeaponTuning = BOT_WEAPON_TUNING[id],
): FireController {
  return new WeaponFireController(id, WEAPONS[id], tuning, rng);
}

/** Armed and past the spawn stagger, so a test can get straight to the trigger. */
function armed(id: BotWeaponId, rng: () => number, tuning?: BotWeaponTuning): FireController {
  const fire = controller(id, rng, tuning);
  fire.arm();
  // The stagger is at most FIRST_SHOT_DELAY_MIN + SPAN; one tick past it
  // clears the cooldown without touching the magazine.
  fire.tick(FIRST_SHOT_DELAY_MIN + FIRST_SHOT_DELAY_SPAN + 1, false);
  return fire;
}

/** Count draws taken across one call, for the draw-order contract. */
function counting(values: number[]): { rng: () => number; taken: () => number } {
  let i = 0;
  return {
    rng: () => (i < values.length ? values[i++]! : (i++, 0.999)),
    taken: () => i,
  };
}

describe('BOT_WEAPON_TUNING', () => {
  test('BOT_WEAPON_IDS lists exactly the tuned weapons', () => {
    // The list is hand-written because Object.keys erases the union; this is
    // what stops a weapon being tuned and then silently left out of the
    // mixed draw.
    expect([...BOT_WEAPON_IDS].sort()).toEqual(Object.keys(BOT_WEAPON_TUNING).sort());
  });

  test('no bot weapon is the knife', () => {
    expect(BOT_WEAPON_IDS).not.toContain('knife');
  });

  test('a burst pause is never shorter than the weapon it paces', () => {
    // A pause below the def's own fireRate would let a bot cycle its weapon
    // faster than the catalog says it can.
    for (const id of BOT_WEAPON_IDS) {
      expect(BOT_WEAPON_TUNING[id].burstPauseMin).toBeGreaterThanOrEqual(WEAPONS[id].fireRate);
    }
  });

  test('an intra-burst interval is at least one frame', () => {
    // The executor realizes at most one shot per bot per frame, so a burst
    // whose interval undercut a frame would silently drop rounds.
    for (const id of BOT_WEAPON_IDS) {
      if (BOT_WEAPON_TUNING[id].burst > 1) expect(WEAPONS[id].fireRate).toBeGreaterThanOrEqual(1 / 60);
    }
  });

  test('zone weights are a probability split', () => {
    for (const id of BOT_WEAPON_IDS) {
      const t = BOT_WEAPON_TUNING[id];
      expect(t.headChance).toBeGreaterThanOrEqual(0);
      expect(t.legChance).toBeGreaterThanOrEqual(0);
      expect(t.headChance + t.legChance).toBeLessThan(1);
    }
  });

  test('the smg keeps the shipped movement policy exactly', () => {
    // Every re-pinned bot smoke phase runs an smg bot, and those phases were
    // tuned against tranche 6's numbers. If this fails, they are testing a
    // different bot than the one they were written for.
    const t = BOT_WEAPON_TUNING.smg;
    expect(t.nearBand).toBe(DEFAULT_BRAIN_PARAMS.nearBand);
    expect(t.farBand).toBe(DEFAULT_BRAIN_PARAMS.farBand);
    expect(t.engageRange).toBe(DEFAULT_BRAIN_PARAMS.engageRange);
    expect(t.strafeFactor).toBe(DEFAULT_BRAIN_PARAMS.strafeFactor);
  });

  test('the sniper can shoot everything it can see', () => {
    // PERCEPTION_RANGE_M is 80; a longer engage range would be unreachable
    // and a shorter one would leave sight it cannot act on.
    expect(BOT_WEAPON_TUNING.sniper.engageRange).toBe(80);
  });
});

describe('expected damage per second', () => {
  /**
   * Analytic dps at `dist`: rounds per second from the burst cycle, times
   * landed rays per round, times mean zone-multiplied damage.
   *
   * This is a BAND rather than a pin on purpose. The band is the claim worth
   * defending — "a bot does not delete the player, and is not harmless
   * either" — and it is exactly what a retune inside the band should not have
   * to edit. The pre-weapon bot sat at 6.1 dps at 10 m.
   */
  function dps(id: BotWeaponId, dist: number): number {
    const def = WEAPONS[id];
    const t = BOT_WEAPON_TUNING[id];
    const cycle = (t.burst - 1) * def.fireRate + t.burstPauseMin + t.burstPauseSpan / 2;
    const meanZone =
      t.headChance * def.headshotMult + t.legChance * 0.75 + (1 - t.headChance - t.legChance);
    // Beyond engageRange the trigger never pulls (botBrains.ts's gate and
    // bots.ts's, which agree), so the dps is zero rather than the hit-chance
    // floor. Modelling the floor there would credit weapons with damage they
    // structurally cannot deal.
    if (dist >= t.engageRange) return 0;
    const perRound = (def.pellets ?? 1) * botHitChance(dist, t) * def.damage * meanZone;
    return (perRound * t.burst) / cycle;
  }

  test('no weapon deletes the player and none is harmless in its own band', () => {
    // Deliberately WIDE. This gate exists to catch an order-of-magnitude
    // error, which it already has once: eight shotgun pellets each rolling a
    // x4 headshot put that weapon at 57 dps point blank, four times anything
    // else, and nothing else in the suite would have said so. It is not a
    // pin on the tuning — retuning inside these bounds must not cost a test
    // edit, or the next tuner will widen the test instead of thinking.
    for (const id of BOT_WEAPON_IDS) {
      const band = (BOT_WEAPON_TUNING[id].nearBand + BOT_WEAPON_TUNING[id].farBand) / 2;
      expect(dps(id, band)).toBeGreaterThan(3);
      expect(dps(id, band)).toBeLessThan(20);
      expect(dps(id, 0)).toBeLessThan(40);
    }
  });

  test('mid-band lethality stays in reach of the pre-weapon bot', () => {
    // Tranche 6's bot sat at 6.1 dps at 10 m. Every weapon except the
    // shotgun stays within roughly twice that at its own preferred range —
    // this tranche is about character, not difficulty.
    for (const id of BOT_WEAPON_IDS) {
      if (id === 'shotgun') continue; // see the cliff test below
      const band = (BOT_WEAPON_TUNING[id].nearBand + BOT_WEAPON_TUNING[id].farBand) / 2;
      expect(dps(id, band)).toBeLessThan(13);
    }
  });

  test('the shotgun trades every metre of reach for contact damage', () => {
    // The one deliberate outlier, and the trade is what justifies it: it is
    // the ONLY weapon whose curve reaches actual zero, and it gets there
    // inside 11 m. Stated as shape rather than as absolute numbers so a
    // retune inside the band above does not have to edit this.
    expect(dps('shotgun', 1)).toBeGreaterThan(2 * dps('shotgun', 6));
    expect(dps('shotgun', 11)).toBe(0);
    expect(dps('shotgun', 0)).toBeGreaterThan(dps('smg', 0));
    for (const id of BOT_WEAPON_IDS) {
      if (id !== 'shotgun') expect(dps(id, 11)).toBeGreaterThan(0);
    }
  });

  test('the sniper is the only weapon that still bites at 50 m', () => {
    expect(dps('sniper', 50)).toBeGreaterThan(3);
    for (const id of BOT_WEAPON_IDS) {
      if (id !== 'sniper') expect(dps(id, 50)).toBeLessThan(dps('sniper', 50));
    }
  });
});

describe('botHitChance', () => {
  const t = BOT_WEAPON_TUNING.smg;

  test('point blank is the near value', () => {
    expect(botHitChance(0, t)).toBeCloseTo(t.hitChanceNear, 10);
  });

  test('falls linearly by the divisor', () => {
    expect(botHitChance(7, t)).toBeCloseTo(0.3 - 7 / 70, 10);
  });

  test('floors rather than going negative', () => {
    expect(botHitChance(1000, t)).toBe(t.hitChanceMin);
  });

  test('a zero floor really reaches zero', () => {
    expect(botHitChance(20, BOT_WEAPON_TUNING.shotgun)).toBe(0);
  });

  test('never increases with distance', () => {
    for (const id of BOT_WEAPON_IDS) {
      let prev = Infinity;
      for (let d = 0; d <= 100; d += 5) {
        const c = botHitChance(d, BOT_WEAPON_TUNING[id]);
        expect(c).toBeLessThanOrEqual(prev);
        prev = c;
      }
    }
  });
});

describe('botBrainParams', () => {
  test('applies the weapon policy over the shipped defaults', () => {
    const p = botBrainParams(BOT_WEAPON_TUNING.sniper, DEFAULT_BRAIN_PARAMS);
    expect(p.nearBand).toBe(25);
    expect(p.farBand).toBe(45);
    expect(p.engageRange).toBe(80);
    expect(p.strafeFactor).toBe(0.25);
  });

  test('leaves every weapon-independent tunable alone', () => {
    const p = botBrainParams(BOT_WEAPON_TUNING.shotgun, DEFAULT_BRAIN_PARAMS);
    expect(p.climbThreshold).toBe(DEFAULT_BRAIN_PARAMS.climbThreshold);
    expect(p.noProgressTime).toBe(DEFAULT_BRAIN_PARAMS.noProgressTime);
    expect(p.scanPhase).toBe(DEFAULT_BRAIN_PARAMS.scanPhase);
    expect(p.forgetTime).toBe(DEFAULT_BRAIN_PARAMS.forgetTime);
    expect(p.patrolPause).toBe(DEFAULT_BRAIN_PARAMS.patrolPause);
    expect(p.damageAdvance).toBe(DEFAULT_BRAIN_PARAMS.damageAdvance);
  });
});

describe('resolveBotWeapon', () => {
  test('a named weapon spends no draw', () => {
    const c = counting([]);
    expect(resolveBotWeapon('sniper', c.rng)).toBe('sniper');
    expect(c.taken()).toBe(0);
  });

  test('mixed spends exactly one draw and covers the whole list', () => {
    const seen = new Set<BotWeaponId>();
    for (let i = 0; i < BOT_WEAPON_IDS.length; i++) {
      const c = counting([(i + 0.5) / BOT_WEAPON_IDS.length]);
      seen.add(resolveBotWeapon('mixed', c.rng));
      expect(c.taken()).toBe(1);
    }
    expect([...seen].sort()).toEqual([...BOT_WEAPON_IDS].sort());
  });

  test('a draw of exactly 1 stays in range', () => {
    // rng() is documented as [0, 1), but a clamped read costs nothing and an
    // out-of-bounds index here would hand a bot `undefined` for a life.
    expect(BOT_WEAPON_IDS).toContain(resolveBotWeapon('mixed', () => 1));
  });
});

describe('WeaponFireController arming', () => {
  test('the constructor spends no draw; arm() spends exactly one', () => {
    const c = counting([0.5]);
    const fire = controller('smg', c.rng);
    expect(c.taken()).toBe(0);
    fire.arm();
    expect(c.taken()).toBe(1);
  });

  test('arm() fills the magazine and the reserve from the catalog', () => {
    const fire = armed('sniper', queueRng([0]));
    expect(fire.mag).toBe(WEAPONS.sniper.magSize);
    expect(fire.reserve).toBe(WEAPONS.sniper.reserveMax);
  });

  test('the first shot waits out the drawn stagger', () => {
    // Draw 0 → the minimum stagger, one second.
    const fire = controller('pistol', queueRng([0]));
    fire.arm();
    fire.tick(0.99, false);
    expect(fire.ready()).toBe(false);
    fire.tick(0.02, false);
    expect(fire.ready()).toBe(true);
  });

  test('a maximal draw waits the full min+span', () => {
    const fire = controller('pistol', queueRng([1]));
    fire.arm();
    fire.tick(FIRST_SHOT_DELAY_MIN + FIRST_SHOT_DELAY_SPAN - 0.01, false);
    expect(fire.ready()).toBe(false);
    fire.tick(0.02, false);
    expect(fire.ready()).toBe(true);
  });

  test('arm() re-arms a spent controller for a new life', () => {
    const fire = armed('revolver', queueRng([0]));
    fire.pull();
    fire.pull();
    expect(fire.mag).toBe(WEAPONS.revolver.magSize - 2);
    fire.arm();
    expect(fire.mag).toBe(WEAPONS.revolver.magSize);
    expect(fire.reloading).toBe(false);
    expect(fire.ready()).toBe(false); // the fresh stagger is running
  });
});

describe('WeaponFireController cadence', () => {
  test('a semi-auto pull draws its pause and spends one round', () => {
    const c = counting([0, 0.5]); // stagger, then the pause
    const fire = controller('revolver', c.rng);
    fire.arm();
    fire.tick(1.1, false);
    expect(c.taken()).toBe(1);
    fire.pull();
    expect(c.taken()).toBe(2);
    expect(fire.mag).toBe(WEAPONS.revolver.magSize - 1);
    // 0.8 + 0.5 * 0.4 = 1.0
    fire.tick(0.99, false);
    expect(fire.ready()).toBe(false);
    fire.tick(0.02, false);
    expect(fire.ready()).toBe(true);
  });

  test('an smg burst runs at the catalog fire rate and pauses only at its end', () => {
    const c = counting([0, 0.5]); // stagger, then ONE pause at the burst's end
    const fire = controller('smg', c.rng);
    fire.arm();
    fire.tick(1.1, false);
    const before = c.taken();

    fire.pull();                        // round 1 of 3
    expect(c.taken()).toBe(before);     // intra-burst: no draw
    fire.tick(WEAPONS.smg.fireRate, false);
    expect(fire.ready()).toBe(true);

    fire.pull();                        // round 2
    expect(c.taken()).toBe(before);
    fire.tick(WEAPONS.smg.fireRate, false);

    fire.pull();                        // round 3 ends the burst
    expect(c.taken()).toBe(before + 1);
    // 0.9 + 0.5 * 0.6 = 1.2
    fire.tick(1.19, false);
    expect(fire.ready()).toBe(false);
    fire.tick(0.02, false);
    expect(fire.ready()).toBe(true);
  });

  test('a magazine emptying mid-burst still draws exactly one pause', () => {
    // Two rounds left, a burst of three: the burst ends because the mag did.
    // The draw count per pull must depend on the burst position alone.
    const c = counting([0, 0.5, 0.5]);
    const fire = new WeaponFireController('smg', { ...WEAPONS.smg, magSize: 2 },
      BOT_WEAPON_TUNING.smg, c.rng);
    fire.arm();
    fire.tick(1.1, false);
    const before = c.taken();
    fire.pull();
    expect(c.taken()).toBe(before);
    fire.pull();
    expect(fire.mag).toBe(0);
    expect(c.taken()).toBe(before + 1);
  });

  test('a dry magazine is never ready', () => {
    const fire = armed('revolver', queueRng([0, 0, 0, 0, 0, 0, 0, 0]));
    for (let i = 0; i < WEAPONS.revolver.magSize; i++) {
      fire.tick(2, false);
      fire.pull();
    }
    expect(fire.mag).toBe(0);
    expect(fire.ready()).toBe(false);
  });
});

describe('WeaponFireController reloading', () => {
  test('a dry whole-magazine weapon reloads and is unshootable meanwhile', () => {
    const fire = armed('smg', queueRng(repeat(64, 0)));
    for (let i = 0; i < WEAPONS.smg.magSize; i++) { fire.tick(2, true); fire.pull(); }
    expect(fire.mag).toBe(0);
    fire.tick(DT, true);              // dry forces a reload even mid-engagement
    expect(fire.reloading).toBe(true);
    expect(fire.ready()).toBe(false);
    fire.tick(WEAPONS.smg.reloadTime - DT * 2, true);
    expect(fire.reloading).toBe(true);
    fire.tick(DT * 3, true);
    expect(fire.reloading).toBe(false);
    expect(fire.mag).toBe(WEAPONS.smg.magSize);
    expect(fire.reserve).toBe(WEAPONS.smg.reserveMax - WEAPONS.smg.magSize);
  });

  test('a partial magazine is topped up in a lull but not in a firefight', () => {
    const low = Math.floor(WEAPONS.smg.magSize / 3);
    const engagedFire = armed('smg', queueRng(repeat(64, 0)));
    for (let i = 0; i < WEAPONS.smg.magSize - low; i++) { engagedFire.tick(2, true); engagedFire.pull(); }
    expect(engagedFire.mag).toBe(low);
    engagedFire.tick(DT, true);
    expect(engagedFire.reloading).toBe(false);
    engagedFire.tick(DT, false);
    expect(engagedFire.reloading).toBe(true);
  });

  test('the reload runs on frames the bot is not fighting at all', () => {
    // The magazine belongs to the bot, not to the mode it is in: a bot that
    // broke contact and started routing must arrive loaded.
    const fire = armed('smg', queueRng(repeat(64, 0)));
    for (let i = 0; i < WEAPONS.smg.magSize; i++) { fire.tick(2, true); fire.pull(); }
    fire.tick(DT, false);
    expect(fire.reloading).toBe(true);
    for (let i = 0; i < 200; i++) fire.tick(DT, false);
    expect(fire.reloading).toBe(false);
    expect(fire.mag).toBe(WEAPONS.smg.magSize);
  });

  test('a per-round weapon is shootable mid-reload with what has transferred', () => {
    const fire = armed('shotgun', queueRng(repeat(64, 0)));
    for (let i = 0; i < WEAPONS.shotgun.magSize; i++) { fire.tick(2, false); fire.pull(); }
    expect(fire.mag).toBe(0);
    fire.tick(DT, false);
    expect(fire.reloading).toBe(true);
    const interval = WEAPONS.shotgun.reloadTime / WEAPONS.shotgun.magSize;
    fire.tick(interval, false);
    expect(fire.mag).toBe(1);
    fire.tick(2, false);              // clear the cadence, keep reloading
    expect(fire.reloading).toBe(true);
    expect(fire.ready()).toBe(true);  // one shell chambered is enough
  });

  test('firing cancels the rest of a per-round reload', () => {
    const fire = armed('revolver', queueRng(repeat(64, 0)));
    for (let i = 0; i < WEAPONS.revolver.magSize; i++) { fire.tick(2, false); fire.pull(); }
    fire.tick(DT, false);
    const interval = WEAPONS.revolver.reloadTime / WEAPONS.revolver.magSize;
    // interval*2 = 1.0 s, which also clears the drawn 0.8 s burst pause —
    // one tick advances the cadence and the reload together, deliberately.
    fire.tick(interval * 2, false);
    expect(fire.mag).toBe(2);
    expect(fire.ready()).toBe(true);
    fire.pull();
    expect(fire.reloading).toBe(false);
    expect(fire.mag).toBe(1);
  });

  test('a dry reserve leaves the bot empty rather than conjuring rounds', () => {
    const def = { ...WEAPONS.smg, magSize: 2, reserveMax: 2 };
    const fire = new WeaponFireController('smg', def, BOT_WEAPON_TUNING.smg,
      queueRng(repeat(64, 0)));
    fire.arm();
    fire.tick(4, false);
    for (let round = 0; round < 2; round++) {
      fire.pull(); fire.pull();
      for (let i = 0; i < 400; i++) fire.tick(DT, false);
    }
    expect(fire.reserve).toBe(0);
    fire.pull(); fire.pull();
    for (let i = 0; i < 400; i++) fire.tick(DT, false);
    expect(fire.mag).toBe(0);
    expect(fire.reloading).toBe(false);
    expect(fire.ready()).toBe(false);
  });
});

describe('WeaponFireController resolve', () => {
  test('one ray, one hit draw, and a zone draw only when it lands', () => {
    const miss = counting([0.99]);
    const fireA = new WeaponFireController('pistol', WEAPONS.pistol, BOT_WEAPON_TUNING.pistol, miss.rng);
    expect(fireA.resolve(0)).toEqual({ damage: 0, zone: null, rays: 1, hits: 0 });
    expect(miss.taken()).toBe(1);

    const hit = counting([0.01, 0.9]); // lands, then a torso zone
    const fireB = new WeaponFireController('pistol', WEAPONS.pistol, BOT_WEAPON_TUNING.pistol, hit.rng);
    expect(fireB.resolve(0)).toEqual({
      damage: WEAPONS.pistol.damage, zone: 'torso', rays: 1, hits: 1,
    });
    expect(hit.taken()).toBe(2);
  });

  test('zones come from the catalog multipliers, not from the brain', () => {
    const head = new WeaponFireController('sniper', WEAPONS.sniper, BOT_WEAPON_TUNING.sniper,
      queueRng([0.01, 0]));
    expect(head.resolve(0)).toMatchObject({
      damage: damageForPart(WEAPONS.sniper, 'head'), zone: 'head',
    });
    const legs = new WeaponFireController('sniper', WEAPONS.sniper, BOT_WEAPON_TUNING.sniper,
      queueRng([0.01, BOT_WEAPON_TUNING.sniper.headChance + 0.001]));
    expect(legs.resolve(0)).toMatchObject({
      damage: damageForPart(WEAPONS.sniper, 'legs'), zone: 'legs',
    });
  });

  test('the zone split boundaries are exact', () => {
    const t = BOT_WEAPON_TUNING.smg;
    const at = (draw: number): string | null =>
      new WeaponFireController('smg', WEAPONS.smg, t, queueRng([0.01, draw])).resolve(0).zone;
    expect(at(0)).toBe('head');
    expect(at(t.headChance - 1e-9)).toBe('head');
    expect(at(t.headChance)).toBe('legs');
    expect(at(t.headChance + t.legChance - 1e-9)).toBe('legs');
    expect(at(t.headChance + t.legChance)).toBe('torso');
  });

  test('a shotgun draws once per pellet and sums what lands', () => {
    // Four pellets land (torso), four miss. Draws interleave hit-then-zone.
    const script: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (i < 4) script.push(0.01, 0.9);  // hit, torso
      else script.push(0.99);             // miss: no zone draw
    }
    const c = counting(script);
    const fire = new WeaponFireController('shotgun', WEAPONS.shotgun, BOT_WEAPON_TUNING.shotgun, c.rng);
    const out = fire.resolve(0);
    expect(out).toEqual({
      damage: WEAPONS.shotgun.damage * 4, zone: 'torso', rays: 8, hits: 4,
    });
    expect(c.taken()).toBe(4 * 2 + 4);
  });

  test('one headed pellet reddens the whole pull', () => {
    // Same rule weapons.ts applies to the player's hitmarker: the killfeed
    // reports the trigger pull, not an individual pellet.
    const script = [0.01, 0.9, 0.01, 0, ...repeat(6, 0.99)];
    const fire = new WeaponFireController('shotgun', WEAPONS.shotgun, BOT_WEAPON_TUNING.shotgun,
      queueRng(script));
    const out = fire.resolve(0);
    expect(out.zone).toBe('head');
    expect(out.damage).toBe(
      damageForPart(WEAPONS.shotgun, 'torso') + damageForPart(WEAPONS.shotgun, 'head'),
    );
  });

  test('legs only when nothing better landed', () => {
    const legDraw = BOT_WEAPON_TUNING.shotgun.headChance + 0.001;
    const script = [0.01, legDraw, ...repeat(7, 0.99)];
    const fire = new WeaponFireController('shotgun', WEAPONS.shotgun, BOT_WEAPON_TUNING.shotgun,
      queueRng(script));
    expect(fire.resolve(0).zone).toBe('legs');
  });

  test('distance is the only thing that changes the odds', () => {
    // The same draw lands point blank and misses far away.
    const near = new WeaponFireController('smg', WEAPONS.smg, BOT_WEAPON_TUNING.smg,
      queueRng([0.25, 0.9]));
    expect(near.resolve(0).hits).toBe(1);
    const far = new WeaponFireController('smg', WEAPONS.smg, BOT_WEAPON_TUNING.smg,
      queueRng([0.25, 0.9]));
    expect(far.resolve(40).hits).toBe(0);
  });
});
