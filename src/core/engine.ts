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
/**
 * Reduced-fidelity rendering for GPU-less contexts (see initEngine). Read
 * only after initEngine(), like the bindings above.
 */
export let lowFx = false;

let initialized = false;

/**
 * Whether the WebGL implementation is software-rasterized (SwiftShader,
 * llvmpipe and kin), where every triangle, texel and MSAA sample is CPU
 * work. Sniffed on a throwaway 1x1 context BEFORE the real renderer is
 * created, because multisampling is a context-creation attribute: by the
 * time the real context exists it is too late to turn it off. A missing
 * context or debug extension fails closed toward full quality, so a software
 * user misdetected as hardware only gets today's behavior while no hardware
 * user is ever degraded.
 */
function isSoftwareRenderer(): boolean {
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
  if (!gl) return false;
  const raw = gl.getExtension('WEBGL_debug_renderer_info') as unknown;
  if (raw === null || typeof raw !== 'object' || !('UNMASKED_RENDERER_WEBGL' in raw)) return false;
  const token = (raw as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL;
  const name: unknown = gl.getParameter(token);
  return typeof name === 'string' && /swiftshader|llvmpipe|softpipe|software/i.test(name);
}

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
 * @param opts.lowFx force the reduced-fidelity path (pixel ratio 1, no
 *        shadow pass) even on hardware GL. Deliberately NOT part of the
 *        committed match-config query — it is a local rendering concern, not
 *        match rules, so main.ts reads `?lowfx=1` itself rather than routing
 *        it through sessionConfig. Otherwise the path arms itself by
 *        detecting a software rasterizer.
 */
export function initEngine(map: MapName, opts?: { lowFx?: boolean }): void {
  if (initialized) throw new Error('initEngine() called twice');

  const amb = AMBIENCE[map];

  // Decided before the context exists: multisampling is baked in at
  // creation, so the probe above is what lets a software rasterizer skip it.
  lowFx = opts?.lowFx === true || isSoftwareRenderer();
  renderer = new THREE.WebGLRenderer({ antialias: !lowFx });
  renderer.setSize(innerWidth, innerHeight);
  // Software rasterizers pay per texel, per sample and per shadow-caster on
  // the CPU; the authored bot guns tripled that bill. Full quality is
  // untouched — this branch only ever runs where there is no GPU to begin
  // with (or under an explicit `?lowfx=1`).
  renderer.setPixelRatio(lowFx ? 1 : Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = !lowFx;
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

  scene.add(new THREE.HemisphereLight(amb.hemiSky, amb.hemiGround, amb.hemiIntensity));
  const sun = new THREE.DirectionalLight(amb.sunColor, amb.sunIntensity);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Toon shading evaluates lighting per fragment, exposing self-shadow
  // stripes on broad faces. Offset the shadow lookup slightly off the surface.
  sun.shadow.normalBias = 0.04;
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
  scene.add(sun);

  clock = new THREE.Clock();

  // Set last, not first: if the WebGLRenderer constructor throws (no WebGL
  // context), a retry should report THAT, not a bogus "called twice".
  initialized = true;
}
