// domFlags.ts — domination flag markers (browser).
//
// One ring + pole + letter per flag, built once from the live `dom` slice
// after the map builder runs. Deliberately NOT registered in world.ts:
// these are decorative, and registering them would put ring meshes into
// `solids` (bullets/LOS targets) and `colliders` (movement blockers).
// Bullets test `solids` + bot parts (weapons.ts) and LOS tests `solids`
// alone (collision.ts:hasLineOfSight), so unregistered markers are ignored
// by both — the same construction that keeps Bot.aim mounts decorative.
//
// Exposes init-style functions called from main.ts; per-frame cost is one
// cached colour write per flag.
import * as THREE from 'three';
import { scene } from './core/engine';
import { dom } from './core/state';

const COLOR_T = new THREE.Color(0xffcc66);
const COLOR_CT = new THREE.Color(0x66b2ff);
const COLOR_NEUTRAL = new THREE.Color(0xbbbbbb);

interface FlagRig {
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  pole: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  sprite: THREE.Sprite;
  /** Last applied colour key; updateDomFlagColors skips unchanged flags. */
  key: string;
}

const rigs: FlagRig[] = [];

/** Letter board for a flag id, drawn once on a canvas — no asset files. */
function makeLetterSprite(id: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(id, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    // Flag letters read through walls CoD-style: the ring and pole stay
    // occluded, so the point still has a physical place in the world.
    depthTest: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 1.6, 1);
  return sprite;
}

/**
 * Build one marker per live flag. Call once, after BUILDERS[map]() and
 * resetDom() — both must have run, since geometry and the flag list are the
 * inputs. Re-callable: rebuilds from scratch (map switching is a reload, so
 * this runs once per session in practice).
 */
export function buildDomFlags(): void {
  clearDomFlags();
  for (const flag of dom.flags) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(flag.radius - 0.25, flag.radius, 48),
      new THREE.MeshBasicMaterial({ color: COLOR_NEUTRAL.clone(), side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(flag.pos.x, flag.pos.y + 0.05, flag.pos.z);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3, 8),
      new THREE.MeshBasicMaterial({ color: COLOR_NEUTRAL.clone() }),
    );
    pole.position.set(flag.pos.x, flag.pos.y + 1.5, flag.pos.z);
    const sprite = makeLetterSprite(flag.id);
    sprite.position.set(flag.pos.x, flag.pos.y + 3.6, flag.pos.z);
    scene.add(ring, pole, sprite);
    rigs.push({ ring, pole, sprite, key: '' });
  }
  updateDomFlagColors();
}

/**
 * Recolour markers from flag state: owner colour at rest, lerped toward the
 * challenger by capture progress. Cached per flag so steady states never
 * touch a material.
 */
export function updateDomFlagColors(): void {
  dom.flags.forEach((flag, i) => {
    const rig = rigs[i];
    if (!rig) return;
    const key = `${flag.owner ?? 'n'}|${flag.challenger ?? 'n'}|${Math.floor(flag.progress * 8)}`;
    if (key === rig.key) return;
    rig.key = key;
    const base = flag.owner === 'T' ? COLOR_T : flag.owner === 'CT' ? COLOR_CT : COLOR_NEUTRAL;
    const colour = base.clone();
    if (flag.challenger !== null) {
      const incoming = flag.challenger === 'T' ? COLOR_T : COLOR_CT;
      colour.lerp(incoming, Math.min(1, Math.max(0, flag.progress)));
    }
    rig.ring.material.color.copy(colour);
    rig.pole.material.color.copy(colour);
  });
}

/**
 * Remove every marker and free its geometry/materials. Called by
 * buildDomFlags before it rebuilds — module-private, because rebuilding is
 * the only thing that ever needs it.
 */
function clearDomFlags(): void {
  for (const rig of rigs) {
    scene.remove(rig.ring, rig.pole, rig.sprite);
    rig.ring.geometry.dispose();
    rig.ring.material.dispose();
    rig.pole.geometry.dispose();
    rig.pole.material.dispose();
    const spriteMat = rig.sprite.material;
    spriteMat.map?.dispose();
    spriteMat.dispose();
  }
  rigs.length = 0;
}
