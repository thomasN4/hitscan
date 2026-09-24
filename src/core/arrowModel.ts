// One war arrow, shared by the nocked arrow on the longbow viewmodel and every
// loosed arrow in the world. Procedural like the reload cartridges: it is an
// effect the bow spends, not part of the authored stave (docs/assets.md).
//
// Model space: the TIP at the origin, the shaft running back along +z, so the
// arrow points down -z like every weapon. Loosed arrows track their tip.
import * as THREE from 'three';
import { createCelMaterial } from './materials';

/** Nock to point (m): a 30 in war arrow. */
export const ARROW_LENGTH = 0.76;

const SHAFT_RADIUS = 0.0045;
const HEAD_LENGTH = 0.055;
const FLETCH_LENGTH = 0.16;
const FLETCH_HEIGHT = 0.018;

// One material set for every arrow: dozens can stand in the walls at once.
let materials: { shaft: THREE.Material; head: THREE.Material; fletch: THREE.Material; cock: THREE.Material; nock: THREE.Material } | undefined;

function arrowMaterials(): NonNullable<typeof materials> {
  materials ??= {
    shaft: createCelMaterial({ color: 0xc8a169 }),  // ash
    head: createCelMaterial({ color: 0x5b6167 }),   // forged bodkin
    // White goose fletching with a red cock feather: the brightest thing on
    // the arrow, and the part the archer watches recede.
    fletch: createCelMaterial({ color: 0xf2efe6, side: THREE.DoubleSide }),
    cock: createCelMaterial({ color: 0xc23a2b, side: THREE.DoubleSide }),
    nock: createCelMaterial({ color: 0x2a211b }),
  };
  return materials;
}

/** Build a fresh arrow; the caller owns and positions it. */
export function createArrowModel(): THREE.Group {
  const m = arrowMaterials();
  const group = new THREE.Group();
  group.name = 'arrow';

  const shaft = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH - HEAD_LENGTH, 8);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, HEAD_LENGTH + (ARROW_LENGTH - HEAD_LENGTH) / 2);
  group.add(new THREE.Mesh(shaft, m.shaft));

  const head = new THREE.ConeGeometry(SHAFT_RADIUS * 1.25, HEAD_LENGTH, 4);
  head.rotateX(-Math.PI / 2);
  head.translate(0, 0, HEAD_LENGTH / 2);
  group.add(new THREE.Mesh(head, m.head));

  const nock = new THREE.CylinderGeometry(SHAFT_RADIUS * 1.1, SHAFT_RADIUS * 1.1, 0.018, 8);
  nock.rotateX(Math.PI / 2);
  nock.translate(0, 0, ARROW_LENGTH - 0.009);
  group.add(new THREE.Mesh(nock, m.nock));

  // Three vanes at 120°, the cock feather standing straight out to the left
  // (away from the stave for a right-handed archer's arrow pass).
  const vane = new THREE.BufferGeometry();
  const back = ARROW_LENGTH - 0.03;
  const front = back - FLETCH_LENGTH;
  vane.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, back, 0, FLETCH_HEIGHT, back - 0.02, 0, 0, front,
    0, FLETCH_HEIGHT, back - 0.02, 0, FLETCH_HEIGHT * 0.35, front + 0.01, 0, 0, front,
  ], 3));
  vane.computeVertexNormals();
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(vane, i === 0 ? m.cock : m.fletch);
    mesh.rotation.z = Math.PI / 2 + i * (2 * Math.PI / 3);
    group.add(mesh);
  }
  return group;
}
