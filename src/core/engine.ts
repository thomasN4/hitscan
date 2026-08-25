// core/engine.ts — browser-only rendering singletons (renderer, scene,
// camera, clock, lights).
//
// These used to be built at module scope, which made EVERY module in src/
// unimportable outside a browser (constructing a WebGLRenderer and touching
// document.body on import). They are now created by initEngine(), which
// main.ts calls first — so pure simulation code can be imported and unit
// tested in Node.
//
// The exported bindings are `let`, assigned by initEngine(). ES module live
// bindings mean importers see the real object after init; reading them at
// module scope (before init) yields undefined, which is why browser-side
// modules expose their own init* functions rather than wiring things up on
// import. They are deliberately declared at their non-optional type rather
// than `T | undefined`: the module's documented contract is "read only after
// initEngine()", and typing them optional would push a null check onto every
// consumer for a violation the contract already rules out. See main.ts for
// the required init order.
import * as THREE from 'three';
import { AMBIENCE, BASE_FOV, type MapName } from './state';

export let renderer: THREE.WebGLRenderer;
export let scene: THREE.Scene;
export let camera: THREE.PerspectiveCamera;
export let clock: THREE.Clock;

let initialized = false;

/**
 * Build the renderer/scene/camera/lights and attach the canvas to the page.
 * Must be called exactly once, before any other init* function or any code
 * that touches `scene`/`camera`. A second call THROWS rather than no-opping:
 * it would orphan the first canvas, so the loud failure is the point.
 *
 * @param map which map is about to be built — selects the sky/fog/light
 *        palette from `state.ts:AMBIENCE`. Passed in rather than read from
 *        `session` so this module keeps no opinion about where config comes
 *        from; main.ts has already parsed the query by the time it calls here.
 */
export function initEngine(map: MapName): void {
  if (initialized) throw new Error('initEngine() called twice');

  const amb = AMBIENCE[map];

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  // Background and fog share one colour so geometry fades into the horizon
  // instead of silhouetting against it.
  scene.background = new THREE.Color(amb.background);
  scene.fog = new THREE.Fog(amb.background, amb.fogNear, amb.fogFar);

  // FOV is animated by weapons.ts when aiming (BASE_FOV hip-fire -> per-weapon
  // zoom targets, down to ~6° at full sniper zoom).
  camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.1, 300);

  scene.add(new THREE.HemisphereLight(amb.hemiSky, amb.hemiGround, 0.85));
  const sun = new THREE.DirectionalLight(amb.sunColor, 1.4);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
  scene.add(sun);

  clock = new THREE.Clock();

  // Set last, not first: if the WebGLRenderer constructor throws (no WebGL
  // context), a retry should report THAT, not a bogus "called twice".
  initialized = true;
}
