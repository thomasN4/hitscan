import { afterEach, expect, test } from 'vitest';
import { WEAPONS, RECOIL_CAP, RECOIL_YAW_CAP, loadout, lastLoadout, ammoStore,
  weapon, setLoadout, sanitizeLoadout, equippedId, type WeaponDef } from '../core/state';
import { damageForPart } from './damage';
import { computeSpread } from './accuracy';
import { convertOnSwap, decayRecoil, decaySpray, decayToward } from './recoil';
import { BOT_WEAPON_TUNING, WeaponFireController, resolveBotWeapon } from './botWeapons';

const def = WEAPONS.ak47;
const original = { ...loadout };
afterEach(() => setLoadout(original.primary, original.secondary));

test('AK kills a full-health target in two headshots or four body shots', () => {
  const head = damageForPart(def, 'head');
  expect(head).toBe(60);
  expect(100 - head).toBeGreaterThan(0);
  expect(100 - 2 * head).toBeLessThanOrEqual(0);
  expect(damageForPart(def, 'torso')).toBe(30);
  expect(Math.ceil(100 / damageForPart(def, 'torso'))).toBe(4);
  expect(damageForPart(def, 'legs')).toBe(22.5);
});

test('AK loadout persists, arms its ammo and rejects the secondary position', () => {
  const saved = { primary: 'ak47', secondary: 'pistol' };
  expect(sanitizeLoadout(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  setLoadout('ak47', 'pistol');
  expect(equippedId(0)).toBe('ak47');
  expect(lastLoadout).toEqual(saved);
  expect(ammoStore[0]).toEqual({ mag: 30, reserve: 90 });
  expect(weapon.name).toBe('AK-47');
  expect(weapon.reloadTime).toBe(2.5);
  expect(weapon.fireRate).toBe(0.1);
  expect(sanitizeLoadout({ primary: 'smg', secondary: 'ak47' })).toBeUndefined();
  expect(() => setLoadout('smg', 'ak47')).toThrow('not a secondary');
});

test('AK bot bursts fire at 600 RPM and pause after the third shot', () => {
  const tuning = BOT_WEAPON_TUNING.ak47;
  if (tuning.kind !== 'ranged') throw new Error('AK must be ranged');
  expect(resolveBotWeapon('ak47', () => { throw new Error('Named choice must not draw'); })).toBe('ak47');
  expect(resolveBotWeapon('mixed', () => .99)).toBe('ak47');
  expect(def.semiAuto).not.toBe(true);
  expect(60 / def.fireRate).toBe(600);
  const fire = new WeaponFireController('ak47', def, tuning, () => 0);
  fire.arm();
  fire.tick(4, false);
  for (let shot = 0; shot < 2; shot++) {
    expect(fire.ready()).toBe(true);
    fire.pull();
    fire.tick(.099, false);
    expect(fire.ready()).toBe(false);
    fire.tick(.0011, false);
  }
  fire.pull();
  expect(fire.mag).toBe(27);
  fire.tick(.899, false);
  expect(fire.ready()).toBe(false);
  fire.tick(.002, false);
  expect(fire.ready()).toBe(true);
});

function burst(w: WeaponDef): { recoil: number; recoilYaw: number; spray: number } {
  let recoil = 0, recoilYaw = 0, spray = 1;
  // A fixed signed kick sequence compares the weapons without random test failures.
  for (let i = 0; i < 10; i++) {
    recoil = decayRecoil(Math.min(RECOIL_CAP, recoil + w.recoilKick), w.fireRate, w.recoilRecover);
    recoilYaw = decayToward(Math.min(RECOIL_YAW_CAP, recoilYaw + w.yawKick / 2), w.fireRate, w.yawRecover);
    spray = decaySpray(Math.min(w.sprayCap, spray + w.sprayKick), w.fireRate, w.sprayRecover);
  }
  return { recoil, recoilYaw, spray };
}

test('AK taps are tighter but sustained climb, drift and bloom exceed SMG', () => {
  const cone = (w: WeaponDef): number => computeSpread({ crouchLerp: 1, moveLerp: 0,
    airLerp: 0, spray: 1, inherent: w.inherent, adsMul: w.spreadMul });
  expect(cone(def)).toBeLessThan(cone(WEAPONS.smg));
  const ak = burst(def), smg = burst(WEAPONS.smg);
  expect(ak.recoil * def.punchRad).toBeGreaterThan(smg.recoil * WEAPONS.smg.punchRad);
  expect(ak.recoilYaw * def.punchRad).toBeGreaterThan(smg.recoilYaw * WEAPONS.smg.punchRad);
  expect(ak.spray).toBeGreaterThan(smg.spray);
  expect(decayRecoil(ak.recoil, 2, def.recoilRecover)).toBe(0);
  expect(decayToward(ak.recoilYaw, 10, def.yawRecover)).toBe(0);
  expect(decaySpray(ak.spray, 10, def.sprayRecover)).toBe(1);
});

test('AK swap conversion preserves aim punch and spray below shared caps', () => {
  const caps = { recoil: RECOIL_CAP, recoilYaw: RECOIL_YAW_CAP };
  const before = { recoil: 2, recoilYaw: .5, spray: 1.5 };
  const out = convertOnSwap(before, def, WEAPONS.pistol, caps);
  expect(out.recoil * WEAPONS.pistol.punchRad).toBeCloseTo(before.recoil * def.punchRad);
  expect(out.recoilYaw * WEAPONS.pistol.punchRad).toBeCloseTo(before.recoilYaw * def.punchRad);
  const back = convertOnSwap(out, WEAPONS.pistol, def, caps);
  expect(back.recoil).toBeCloseTo(before.recoil);
  expect(back.recoilYaw).toBeCloseTo(before.recoilYaw);
  expect(back.spray).toBe(before.spray);
});
