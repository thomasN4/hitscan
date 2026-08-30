// sim/validateWeapons.ts — static sanity checks over the weapon table.
//
// Pure: weapon defs in, human-readable violation strings out. Caps come from
// core/state.ts rather than restated literals — RECOIL_CAP/BASE_FOV are
// already wired into every call site, and a second copy here would drift.
//
// THESE BOUNDS ARE NECESSARY, NOT SUFFICIENT. Passing them means an
// accumulator CAN grow, not that it grows to the figure its tuning comment
// quotes: decay runs during fire, so sprayRecover 0.45 once cleared its bound
// here and still peaked at 1.28 against a documented 2.8. The loop-replaying
// simulations in sim/recoil.test.ts are what pin actual numbers; this module
// is only the floor on sanity.
//
// The semiAuto exemptions are deliberate, not gaps: the sniper over-drains
// both recoil rates because full settle inside the bolt cycle IS the feel,
// and the vertical settle is what makes scopeGate work. A rule without the
// exemption flags shipped-correct tuning, and the obvious "fix" breaks the
// scope gate. The melee exemption is the same shape: the knife's zero
// magSize/reloadTime ARE the contract (a blade holds no rounds), so those
// two bounds are firearm-only — while every kick/spray/punch bound still
// applies to a swing, and the reach fields owe their own pairing rule.

import { RECOIL_CAP, BASE_FOV, type WeaponDef } from '../core/state';

/** View climb at RECOIL_CAP beyond which pulling down can't track the kick. */
const MAX_CLIMB_DEG = 10;

/**
 * Check every weapon def against the tuning invariants that have been fixed
 * by hand (`46900f7`, `b080350`, `ce1c3c5`) and return one violation string
 * per problem, naming the weapon, the offending field and the consequence.
 * An empty array means every static bound held.
 *
 * Consumers:
 * - validateWeapons.test.ts gates the REAL WEAPONS table — a bad constant
 *   fails `npm test`.
 * - main.ts logs each string via console.error behind import.meta.env.DEV.
 */
export function validateWeapons(defs: readonly WeaponDef[]): string[] {
  const out: string[] = [];
  for (const def of defs) {
    const name = def.name;
    // Trim float noise in messages; NaN survives as 'NaN', which is fine —
    // the missing-bound rules below flag it anyway.
    const num = (v: number): number => parseFloat(Number(v).toPrecision(3));

    // ---------- Sustained-fire bounds ----------
    // Decay runs during fire too, so recovery must lose to the per-second
    // input or the accumulator never leaves rest. The vertical and yaw rules
    // apply only while the weapon actually sustains fire: a semiAuto weapon
    // fires once per press, and the sniper's full settle inside the bolt
    // cycle is deliberate (see header).
    if (!def.semiAuto && !(def.recoilRecover < def.recoilKick / def.fireRate)) {
      out.push(`${name}: recoilRecover ${num(def.recoilRecover)} exceeds sustained-fire input ${num(def.recoilKick / def.fireRate)} (kick ${num(def.recoilKick)} per ${def.fireRate}s) — recoil never climbs, it just vibrates`);
    }
    if (!def.semiAuto && !(def.yawRecover * def.fireRate < def.yawKick / 2)) {
      out.push(`${name}: yawRecover ${num(def.yawRecover)} drains more per shot interval than the MEAN kick (${num(def.yawKick / 2)}) — the walk returns to 0 before every shot and no bullet is displaced`);
    }
    if (!(def.sprayRecover < def.sprayKick / def.fireRate)) {
      out.push(`${name}: sprayRecover ${num(def.sprayRecover)} exceeds sustained-fire input ${num(def.sprayKick / def.fireRate)} — sprays will not bloom`);
    }

    // ---------- Static sanity ----------
    // Every bound tests its own VALID case under a negation (`if (!(ok))`),
    // never the broken case directly: NaN compares false against everything,
    // so only the negated shape can flag it. The sustained-fire rules above
    // use the same pattern.
    if (!(def.sprayCap > 1)) {
      out.push(`${name}: sprayCap ${num(def.sprayCap)} must exceed 1 — rested spray IS 1, so a cap at/below it means spray never accumulates`);
    }
    if (!(def.inherent > 0)) {
      out.push(`${name}: inherent ${num(def.inherent)} must be > 0 — the rest cone is the weapon's floor accuracy cost`);
    }
    if (!(def.recoilKick > 0)) {
      out.push(`${name}: recoilKick ${num(def.recoilKick)} must be > 0 — a zero kick means vertical recoil does nothing`);
    }
    if (!(def.yawKick > 0)) {
      out.push(`${name}: yawKick ${num(def.yawKick)} must be > 0 — a zero kick means horizontal recoil does nothing`);
    }

    // The type already promises a non-empty number[]; the runtime guard is
    // kept because defs can be assembled by hand in tests and by JS callers
    // tsc never sees — the validator is exactly the place that must not
    // trust that promise.
    if (!Array.isArray(def.zoomFovs) || def.zoomFovs.length === 0) {
      out.push(`${name}: zoomFovs must be a non-empty array — the wheel has nothing to cycle`);
    } else {
      // Iteration (not index math) keeps this honest under
      // noUncheckedIndexedAccess: `prev` is undefined exactly for the first
      // step, where no monotonicity claim exists yet.
      let prev: number | undefined;
      let i = 0;
      for (const fov of def.zoomFovs) {
        if (!(fov < BASE_FOV)) {
          out.push(`${name}: zoomFovs[${i}] ${num(fov)} must sit below BASE_FOV (${BASE_FOV}) — a step at/above hip FOV widens the view instead of zooming`);
        }
        if (prev !== undefined && !(fov < prev)) {
          out.push(`${name}: zoomFovs must strictly decrease (${num(prev)} then ${num(fov)}) — a flat/rising step zooms nothing`);
        }
        prev = fov;
        i++;
      }
    }

    // The knife's zero mag/reload is the CONTRACT (a blade holds no rounds
    // and never reloads — see WEAPONS.knife), not broken tuning, so these
    // two bounds are firearm-only. Everything else applies to a melee weapon
    // unchanged: kicks must still kick, spray must still bloom, the
    // crosshair must still cost something at rest.
    if (!def.melee && !(def.magSize > 0)) {
      out.push(`${name}: magSize ${num(def.magSize)} must be > 0 — the magazine holds nothing`);
    }

    // Pellet weapons: a pull fires at least one ray, and the fixed pattern
    // (pelletCone) only exists where there IS a pattern. A zero cone would
    // make pellets laser-tight — contradicting the fixed-choke model.
    if (def.pellets !== undefined && !(def.pellets > 0)) {
      out.push(`${name}: pellets ${num(def.pellets)} must be > 0 when present — a trigger pull fires at least one ray`);
    }
    if (def.pelletCone !== undefined) {
      if (!(def.pelletCone > 0)) {
        out.push(`${name}: pelletCone ${num(def.pelletCone)} must be > 0 when present — a zero cone contradicts the fixed-pattern choke model`);
      }
      if (def.pellets === undefined) {
        out.push(`${name}: pelletCone without pellets does nothing — single-ray weapons have no pattern to fix`);
      }
    }
    // Crosshair gain override: below 1 the arms would sit INSIDE the true
    // scatter, claiming pellets land tighter than they do — the one lie the
    // proportional reticle must never tell. Absent is the common case
    // (shared CROSSHAIR_GAIN); NaN fails the negated compare like every
    // bound here.
    if (def.crosshairGain !== undefined && !(def.crosshairGain >= 1)) {
      out.push(`${name}: crosshairGain ${num(def.crosshairGain)} must be >= 1 — arms inside the true scatter would understate the spread`);
    }
    if (!(def.reserveMax >= 0)) {
      out.push(`${name}: reserveMax ${num(def.reserveMax)} must be >= 0 — negative reserve breaks reload accounting`);
    }
    if (!(def.fireRate > 0)) {
      out.push(`${name}: fireRate ${num(def.fireRate)} must be > 0 — every sustained-fire bound divides by it`);
    }
    if (!def.melee && !(def.reloadTime > 0)) {
      out.push(`${name}: reloadTime ${num(def.reloadTime)} must be > 0 — an instant reload skips the mechanic`);
    }

    // Melee pairing, the same both-directions pattern as pellets/pelletCone:
    // the reach fields and the backstab multiplier exist exactly when the
    // def swings.
    if (def.melee) {
      if (!(def.range !== undefined && def.range > 0)) {
        out.push(`${name}: range ${num(def.range ?? NaN)} must be > 0 when melee — a swing without reach connects with nothing`);
      }
      if (!(def.arcRad !== undefined && def.arcRad > 0 && def.arcRad <= Math.PI)) {
        out.push(`${name}: arcRad ${num(def.arcRad ?? NaN)} must lie in (0, π] when melee — an arc at/below 0 swings at nothing, past a half-turn it strikes behind`);
      }
      if (!(def.backstabMult !== undefined &&
            Number.isFinite(def.backstabMult) && def.backstabMult >= 1)) {
        out.push(`${name}: backstabMult ${num(def.backstabMult ?? NaN)} must be finite and >= 1 when melee — a backstab can never pay less than a front strike`);
      }
    } else if (def.range !== undefined || def.arcRad !== undefined || def.backstabMult !== undefined) {
      out.push(`${name}: range/arcRad/backstabMult without melee does nothing — only a melee weapon swings`);
    }
    if (!(def.damage > 0)) {
      out.push(`${name}: damage ${num(def.damage)} must be > 0 — the weapon cannot hurt anything`);
    }
    if (!(def.headshotMult >= 1)) {
      out.push(`${name}: headshotMult ${num(def.headshotMult)} must be >= 1 — headshots must not hit softer than the torso`);
    }

    if (def.scopeGate !== undefined &&
        !(def.scopeGate > 0 && def.scopeGate < RECOIL_CAP)) {
      out.push(`${name}: scopeGate ${num(def.scopeGate)} must lie in (0, RECOIL_CAP = ${RECOIL_CAP}) — a gate at/below 0 never blocks, at/above the cap it never opens`);
    }

    const climbDeg = def.punchRad * RECOIL_CAP * 180 / Math.PI;
    if (!(climbDeg < MAX_CLIMB_DEG)) {
      out.push(`${name}: punchRad ${num(def.punchRad)} climbs ${num(climbDeg)}° over a full recoil climb — past ~${MAX_CLIMB_DEG}° the aim outruns any pull-down`);
    }
  }
  return out;
}
