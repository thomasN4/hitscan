// sim/ammo.ts — the low-ammo threshold behind the HUD reload hint.
//
// Pure. The hint used to hardcode `mag <= 10`, written when the SMG (30-round
// mag) was the only weapon; the sniper's FULL mag is also 10, so it advertised
// a reload that tryReload would refuse (issue #10). A third of the magazine
// keeps the SMG's original threshold exactly while making the rule per-weapon.

/** True when `mag` rounds left counts as "think about reloading" for this weapon. */
export function isLowAmmo(mag: number, magSize: number): boolean {
  return mag <= Math.ceil(magSize / 3);
}
