// First-person prop construction, independent of input, firing and the engine.
// Coordinates are metres: the muzzle points down -z. Each model returns the
// offset that centers its sight line; the outer group owns cosmetic action poses.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createCelMaterial } from './materials';
import type { WeaponId } from './state';
import { createAuthoredWeaponRig, type AuthoredWeaponRig, type WeaponAssets } from './weaponAssets';

export interface WeaponViewModel {
  authored?: AuthoredWeaponRig;
  group: THREE.Group;
  body: THREE.Group;
  mechanisms: Partial<Record<'magazine' | 'pump' | 'cylinder' | 'rotor' | 'hammer' | 'bolt' | 'slide' | 'shell', THREE.Object3D>>;
  rest: Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>;
  aimOffset: { x: number; y: number };
}

type Profile = ReadonlyArray<readonly [number, number]>; // z/y side profile

function profileGeometry(points: Profile, width: number, bevel = 0.004): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => { if (i === 0) shape.moveTo(z, y); else shape.lineTo(z, y); });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: bevel > 0, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 2, steps: 1, curveSegments: 8,
  });
  geometry.translate(0, 0, -width / 2);
  geometry.rotateY(-Math.PI / 2); // profile x becomes world z; extrusion becomes x
  return geometry;
}

/** Build a fresh model; caller owns it for the page's lifetime. */
export function createWeaponViewModel(id: WeaponId, weaponAssets?: WeaponAssets): WeaponViewModel {
  const group = new THREE.Group();
  group.name = `viewmodel-${id}`;
  const body = new THREE.Group();
  const offset = id === 'sniper' ? { x: 0.26, y: 0.12 }
    : id === 'shotgun' ? { x: 0.25, y: 0.105 }
      : id === 'smg' ? { x: 0.25, y: 0.14 } : { x: 0.24, y: 0.15 };
  const sightLine = id === 'pistol' ? -0.012 : id === 'revolver' ? 0.037 : id === 'shotgun' ? .034 : 0;
  body.position.set(offset.x, -offset.y, id === 'pistol' || id === 'revolver' ? -0.43 : id === 'shotgun' ? -.53 : -0.57);
  group.add(body);

  const steel = createCelMaterial({ color: 0x2b2b2b });
  const dark = createCelMaterial({ color: 0x111111 });
  const silver = createCelMaterial({ color: 0xb9bdc6 });
  const olive = createCelMaterial({ color: 0x24301f });

  function part(geometry: THREE.BufferGeometry, material: THREE.MeshToonMaterial,
    x: number, y: number, z: number, parent: THREE.Object3D = body): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'weapon-part'; // selective crease + silhouette ink in the art pass
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  function box(w: number, h: number, d: number, x: number, y: number, z: number,
    material = steel, radius = 0.005, parent: THREE.Object3D = body): THREE.Mesh {
    return part(new RoundedBoxGeometry(w, h, d, 1, radius), material, x, y, z, parent);
  }
  function cylinder(radius: number, length: number, x: number, y: number, z: number,
    material = steel, endRadius = radius, parent: THREE.Object3D = body): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(endRadius, radius, length, 20);
    geometry.rotateX(Math.PI / 2);
    return part(geometry, material, x, y, z, parent);
  }
  function profile(points: Profile, width: number, material = steel, parent: THREE.Object3D = body): THREE.Mesh {
    return part(profileGeometry(points, width), material, 0, 0, 0, parent);
  }
  function ring(radius: number, tube: number, x: number, y: number, z: number,
    material = dark): THREE.Mesh {
    return part(new THREE.TorusGeometry(radius, tube, 6, 20), material, x, y, z);
  }
  function muzzle(radius: number, z: number, y: number, material = steel): void {
    // A recessed dark bore and metal rim read as a tube rather than a capped rod.
    cylinder(radius, 0.022, 0, y, z, material);
    cylinder(radius * 0.69, 0.002, 0, y, z - 0.012, dark);
    ring(radius * 0.85, radius * 0.15, 0, y, z - 0.013, material);
  }
  function sights(front: number, rear: number, aperture = false, height = 0.028): void {
    box(0.010, height, 0.012, 0, sightLine - height / 2, front, dark, 0.002);
    if (aperture) {
      ring(0.015, 0.003, 0, 0, rear);
      box(0.04, 0.018, 0.026, 0, -0.025, rear, dark, 0.003);
    } else {
      box(0.011, height, 0.018, -0.015, sightLine - height / 2, rear, dark, 0.002);
      box(0.011, height, 0.018, 0.015, sightLine - height / 2, rear, dark, 0.002);
      box(0.041, 0.008, 0.018, 0, sightLine - height - 0.004, rear, dark, 0.002);
    }
  }
  function triggerGuard(z: number, y: number, length = 0.08): void {
    // An open, beveled side-profile loop, extruded only a narrow width.
    const shape = new THREE.Shape();
    shape.moveTo(z - length / 2, y);
    shape.lineTo(z + length / 2, y);
    shape.quadraticCurveTo(z + length * 0.68, y - 0.065, z, y - 0.065);
    shape.quadraticCurveTo(z - length * 0.68, y - 0.065, z - length / 2, y);
    const hole = new THREE.Path();
    hole.moveTo(z - length / 2 + 0.01, y - 0.009);
    hole.quadraticCurveTo(z - length * 0.43, y - 0.052, z, y - 0.052);
    hole.quadraticCurveTo(z + length * 0.43, y - 0.052, z + length / 2 - 0.01, y - 0.009);
    hole.closePath();
    shape.holes.push(hole);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: false, curveSegments: 8, steps: 1 });
    geometry.translate(0, 0, -0.007);
    geometry.rotateY(-Math.PI / 2);
    part(geometry, dark, 0, 0, 0);
    const trigger = box(0.008, 0.033, 0.009, 0, y - 0.021, z, dark, 0.002);
    trigger.rotation.x = -0.25;
  }
  const mechanisms: WeaponViewModel['mechanisms'] = {};
  function assembly(children: THREE.Object3D[], pivot = new THREE.Vector3()): THREE.Group {
    const node = new THREE.Group();
    node.position.copy(pivot);
    body.add(node);
    for (const child of children) {
      body.remove(child);
      child.position.sub(pivot);
      node.add(child);
    }
    return node;
  }

  let mag: THREE.Mesh | undefined;
  let authored: AuthoredWeaponRig | undefined;
  switch (id) {
    case 'smg': {
      cylinder(0.038, 0.32, 0, -0.055, 0.015);
      box(0.074, 0.058, 0.29, 0, -0.081, 0.015);
      cylinder(0.031, 0.15, 0, -0.055, -0.21, dark);
      cylinder(0.018, 0.13, 0, -0.055, -0.335);
      muzzle(0.023, -0.405, -0.055);
      for (const z of [-0.255, -0.23, -0.205, -0.18]) ring(0.032, 0.0025, 0, -0.055, z);
      profile([[0.07, -0.10], [0.14, -0.10], [0.21, -0.245], [0.135, -0.245]], 0.05, dark);
      profile([[0.16, -0.04], [0.39, -0.055], [0.405, -0.19], [0.35, -0.19], [0.30, -0.085], [0.16, -0.075]], 0.036, dark);
      box(0.052, 0.16, 0.035, 0, -0.12, 0.40, dark, 0.012);
      triggerGuard(0.055, -0.10);
      mag = profile([[-0.07, -0.10], [-0.016, -0.10], [0.0, -0.21], [-0.018, -0.315], [-0.076, -0.305], [-0.055, -0.21]], 0.038);
      box(0.043, 0.012, 0.062, 0, -0.31, -0.047, dark, 0.003, mag);
      mechanisms.slide = box(0.002, 0.026, 0.065, 0.038, -0.055, 0.055, dark, 0.001);
      sights(-0.27, 0.14, true);
      break;
    }
    case 'sniper': {
      profile([[-0.19, -0.08], [0.15, -0.08], [0.24, -0.12], [0.42, -0.105], [0.43, -0.225], [0.34, -0.225], [0.22, -0.16], [0.15, -0.245], [0.09, -0.225], [0.115, -0.13], [-0.19, -0.14]], 0.062, olive);
      cylinder(0.024, 0.34, 0, -0.072, -0.025);
      cylinder(0.014, 0.49, 0, -0.072, -0.43, steel, 0.011);
      muzzle(0.018, -0.68, -0.072);
      box(0.076, 0.13, 0.027, 0, -0.165, 0.435, dark, 0.009);
      triggerGuard(0.075, -0.135);
      mag = box(0.045, 0.075, 0.095, 0, -0.162, -0.045);
      for (const z of [-0.10, 0.09]) {
        box(0.03, 0.033, 0.035, 0, -0.036, z, dark);
        ring(0.024, 0.004, 0, 0, z);
      }
      cylinder(0.024, 0.24, 0, 0, 0, dark);
      cylinder(0.042, 0.07, 0, 0, -0.16, dark, 0.026);
      cylinder(0.034, 0.06, 0, 0, 0.155, dark);
      cylinder(0.028, 0.002, 0, 0, 0.187, olive);
      ring(0.031, 0.003, 0, 0, 0.187);
      const turret = cylinder(0.012, 0.035, 0, 0.031, 0.005, dark);
      turret.rotation.x = Math.PI / 2;
      const boltShaft = cylinder(0.018, 0.13, 0, -0.07, 0.08);
      const bolt = cylinder(0.006, 0.045, 0.044, -0.07, 0.12);
      bolt.rotation.y = Math.PI / 2;
      const knob = part(new THREE.SphereGeometry(0.014, 12, 8), dark, 0.065, -0.08, 0.12);
      mechanisms.bolt = assembly([boltShaft, bolt, knob], new THREE.Vector3(0, -0.07, 0.12));
      break;
    }
    case 'shotgun': {
      if (!weaponAssets) throw new Error('Shotgun asset was not loaded before viewmodel creation');
      authored = createAuthoredWeaponRig(id, weaponAssets.shotgun);
      body.add(authored.root);
      Object.assign(mechanisms, authored.mechanisms);
      mag = cylinder(.011, .055, 0, 0, 0, createCelMaterial({ color: 0xa94d39 }));
      cylinder(.012, .009, 0, 0, .027, createCelMaterial({ color: 0xc6994f }), .012, mag);
      mechanisms.shell = mag;
      mag.visible = false;
      break;
    }
    case 'pistol': {
      const slide = box(0.058, 0.052, 0.25, 0, -0.048, -0.018, steel, 0.008);
      box(0.055, 0.029, 0.20, 0, -0.086, -0.007, dark, 0.006);
      profile([[0.045, -0.08], [0.105, -0.08], [0.15, -0.235], [0.08, -0.235]], 0.051, dark);
      mag = box(0.040, 0.12, 0.056, 0, -0.185, 0.108, steel, 0.004);
      box(0.056, 0.014, 0.077, 0, -0.064, 0, dark, 0.004, mag);
      triggerGuard(0.007, -0.098, 0.073);
      cylinder(0.016, 0.01, 0, -0.047, -0.148, dark);
      cylinder(0.009, 0.012, 0, -0.080, -0.128, steel);
      const slideDetailStart = body.children.length;
      for (const z of [0.047, 0.060, 0.073, 0.086]) {
        box(0.002, 0.032, 0.003, 0.029, -0.048, z, dark, 0.001);
      }
      box(0.029, 0.002, 0.041, 0.009, -0.021, -0.005, dark, 0.001);
      sights(-0.118, 0.091, false, 0.010);
      const slideDetails = [slide, ...body.children.slice(slideDetailStart)];
      mechanisms.slide = assembly(slideDetails);
      break;
    }
    case 'revolver': {
      if (!weaponAssets) throw new Error('Revolver asset was not loaded before viewmodel creation');
      authored = createAuthoredWeaponRig(id, weaponAssets.revolver);
      body.add(authored.root);
      Object.assign(mechanisms, authored.mechanisms);
      mechanisms.shell = cylinder(.008, .034, 0, 0, 0, createCelMaterial({ color: 0xc6994f }));
      mechanisms.shell.visible = false;
      break;
    }
    case 'knife': {
      // Beveled, asymmetric clip-point profile replaces the two blunt boxes.
      mag = profile([[-0.05, -0.03], [-0.30, -0.03], [-0.41, -0.066], [-0.29, -0.100], [-0.05, -0.104]], 0.007, silver);
      box(0.05, 0.098, 0.019, 0, -0.066, -0.035, steel, 0.008);
      cylinder(0.032, 0.16, 0, -0.066, 0.059, dark, 0.028);
      for (const z of [0.007, 0.034, 0.061, 0.088, 0.115]) ring(0.032, 0.002, 0, -0.066, z);
      cylinder(0.035, 0.018, 0, -0.066, 0.147, steel);
      break;
    }
  }
  if (id === 'smg' || id === 'sniper' || id === 'pistol') {
    if (!mag) throw new Error(`Missing magazine for ${id}`);
    mechanisms.magazine = mag;
  }
  const rest: WeaponViewModel['rest'] = new Map();
  for (const [key, node] of Object.entries(mechanisms)) {
    node.name = `weapon-mechanism-${key}`;
    rest.set(node, { position: node.position.clone(), rotation: node.rotation.clone() });
  }
  return { authored, group, body, mechanisms, rest,
    aimOffset: { x: -offset.x, y: offset.y - sightLine } };
}
