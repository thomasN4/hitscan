// debugView.ts — DEV-only overlay that makes bot navigation watchable in play.
//
// Everything docs/ai-plan.md's tranche 5 learned about routing was won by
// instrumentation rather than observation: position traces, `[botClimb]` console
// phases, hud.ts's `#botDebug` text block. None of them show WHERE a bot thinks
// it is going, and the map is opaque, so a bot routing to a staircase does it
// behind a wall. This draws the two things that answer it — the route a bot is
// walking and who it is pointed at — and drops the world to wireframe so both
// are visible through geometry.
//
// Toggled by main.ts on a key, behind `import.meta.env.DEV` at both call sites
// so it leaves production builds entirely (same idiom as bots.ts:debugLog).
// On/off lives in session.debugView, and hud.ts:updateBotDebug — the per-bot
// y/G/blk/mode text block — rides that flag, so the numbers and the routes
// appear and vanish together.
//
// This is the one place that adds meshes to the scene without going through
// world.ts, deliberately: world.ts owns LEVEL GEOMETRY, and the point of these
// lines is that nothing can shoot, walk into or see through them. They are
// never registered as solids or colliders.
import * as THREE from 'three';
import { scene, camera } from './core/engine';
import { solids } from './world';
import { bots, session } from './core/state';
import type { BrainMode } from './sim/botBrains';
import type { Team } from './core/state';

/**
 * Segment capacity. Bots are menu-clamped to 12 a side, and a cross-map route
 * on the elevation graph is ~23 waypoints; 64 segments per bot leaves headroom
 * for both plus the intent line. Sized once — the whole reason this is one
 * LineSegments rather than a Line per bot is to allocate nothing per frame.
 */
const MAX_BOTS = 24;
const SEGMENTS_PER_BOT = 64;
const MAX_VERTS = MAX_BOTS * SEGMENTS_PER_BOT * 2;

/**
 * Route polyline colours, by team.
 *
 * Fully saturated and deliberately unlike anything in the map: the scene is
 * dusty tan (engine.ts's 0xbfae8f) and the wireframe it draws over is brown, so
 * the first palette tried here — team amber and steel blue — was legible on
 * paper and invisible on screen at 1 px. WebGL caps line width at 1 px, so
 * contrast is the ONLY lever these lines have.
 */
const ROUTE_COLOR: Record<Team, readonly [number, number, number]> = {
  T: [1.0, 0.1, 0.8],     // magenta
  CT: [0.15, 0.45, 1.0],  // electric blue
};

/**
 * Intent-line colours, by brain mode — all four, exhaustively, since a
 * Record<BrainMode, …> fails to compile when a mode is added without a
 * colour. `engage` and `route` are the two active modes the hysteresis in
 * botBrains.ts:DefaultBrain.decide flips between; `search` (memory scan:
 * remembered-position arrival, routing dead end, or damage reaction) and
 * `hold` (memory forgotten, or plain sight loss before any memory) get
 * distinct warm hues so a standing bot is never misread as routing.
 */
const MODE_COLOR: Record<BrainMode, readonly [number, number, number]> = {
  hold: [1.0, 0.5, 0.0],    // orange
  search: [1.0, 1.0, 0.0],  // yellow
  route: [0.1, 1.0, 0.35],  // green
  engage: [1.0, 0.0, 0.0],  // red
};

/**
 * Brightness tiers over the mode tint, by whether THIS bot could actually
 * fire at its focus (issue #46): full = inside engage range with the frame's
 * own visual observation AGREEING with the intent's focus (sight is proven
 * by acquisition — no extra probe is paid); mid = inside range but sight
 * unproven or blocked; dim = no shootable observation at all — memory
 * pursuit and search never grade a line shootable, even when the bot
 * exposes a scan lookAt. Hue stays the mode's — the gates ride brightness
 * alone, so one legend covers both. Without the grading, every bot with a
 * live target drew an identical line however far away it was and however
 * many walls stood between, which read as "everyone is engaging me through
 * walls".
 */
const GATE_BRIGHTNESS = { shoot: 1, range: 0.5, track: 0.25 } as const;

/**
 * Marker half-size as a fraction of the distance to it, so it holds a constant
 * SCREEN size instead of shrinking away. A world-sized marker on a bot across
 * the map is a pixel, which is the problem it exists to solve.
 */
const MARKER_SCALE = 0.022;

/** How far above a bot's feet the marker floats — clear of the 2.17 m head cube. */
const MARKER_HEIGHT = 2.6;

let overlay: THREE.LineSegments | undefined;
let positions: Float32Array | undefined;
let colors: Float32Array | undefined;
/** Materials flipped to wireframe by the x-ray, held so toggle-off restores exactly what it changed. */
const wireframed = new Set<THREE.Material>();
/** The scene's own fog while the x-ray has it switched off. */
let savedFog: THREE.Scene['fog'] = null;
/** Reused every frame — the overlay allocates nothing per frame by design. */
const basis: DebugViewBasis = {
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  eye: new THREE.Vector3(),
};

/**
 * The camera basis the screen-facing marker is built in.
 *
 * Passed in rather than read off `camera` so the builder stays pure: `right`
 * and `up` are the camera's world-space x/y axes, `eye` its world position.
 */
export interface DebugViewBasis {
  right: THREE.Vector3;
  up: THREE.Vector3;
  eye: THREE.Vector3;
}

/**
 * What the segment builder needs off a bot — the structural `Bot` from
 * core/state.ts satisfies it.
 *
 * Declared narrowly rather than taking `Bot` so the pure half states its own
 * couplings and can be exercised without standing up a three.js Group per
 * fixture. It is also the list to check when adding an overlay: anything not
 * here is not being drawn.
 */
export interface DebugBotView {
  alive: boolean;
  team: Team;
  mode: BrainMode;
  mesh: { position: THREE.Vector3 };
  navPath: readonly THREE.Vector3[];
  navLeg: number;
  /** World-space point the brain's intent looks at, or null when holding. */
  targetEye: THREE.Vector3 | null;
  /** Whether that focus sits inside the brain's engage range (issue #46). */
  targetInRange: boolean;
  /** Sight gate: true only while the frame's visual observation is held. */
  targetLOS: boolean | null;
  eyePos(): THREE.Vector3;
}

/**
 * Write one bot list's debug segments into `pos`/`col` as line-segment pairs.
 *
 * Pure and engine-free — core/engine.ts has no module-scope side effects, so
 * this module imports in plain Node and this function is unit-tested there
 * (src/debugView.test.ts). Returns the vertex count written, which the caller
 * hands to setDrawRange; nothing is allocated.
 *
 * Per living bot, in this order: the REMAINING route (feet -> path[leg] -> ...
 * -> last waypoint), an intent line from its eye to whatever it is targeting,
 * and a mode-tinted marker floating above it — both graded dimmer unless the
 * bot could actually fire at its target (GATE_BRIGHTNESS). Waypoints already
 * consumed are skipped because the question this answers is "where is it
 * going", not "where has it been".
 *
 * The marker is not decoration. A bot targeting the PLAYER draws an intent line
 * that ends at the camera position, and every point on a segment ending at the
 * viewpoint projects to the same pixel — measured: sampling that line at
 * t = 0..0.999 gives one identical pixel, with the bot 345 px off screen-centre.
 * So the one case you most want to see, "this bot is coming for me", is the one
 * case the line cannot show. The marker carries the mode instead, because it is
 * built in the camera's own basis and therefore always faces the screen.
 */
export function buildDebugSegments(
  list: readonly DebugBotView[],
  pos: Float32Array,
  col: Float32Array,
  view: DebugViewBasis,
): number {
  let v = 0;
  const push = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    c: readonly [number, number, number],
  ): void => {
    if (v + 2 > MAX_VERTS) return; // capacity is a budget, not an invariant: drop, never overflow
    pos[v * 3] = ax; pos[v * 3 + 1] = ay; pos[v * 3 + 2] = az;
    col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
    v++;
    pos[v * 3] = bx; pos[v * 3 + 1] = by; pos[v * 3 + 2] = bz;
    col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
    v++;
  };

  for (const b of list) {
    if (!b.alive) continue;
    const feet = b.mesh.position;
    // Lifted a little off the floor: a polyline drawn exactly on the walkable
    // height coincides with the ground plane and z-fights it in the frames
    // where depthTest is back on.
    const LIFT = 0.05;
    const path = b.navPath;
    let px = feet.x, py = feet.y + LIFT, pz = feet.z;
    const routeCol = ROUTE_COLOR[b.team];
    for (let i = b.navLeg; i < path.length; i++) {
      const w = path[i]!;
      push(px, py, pz, w.x, w.y + LIFT, w.z, routeCol);
      px = w.x; py = w.y + LIFT; pz = w.z;
    }

    const eye = b.eyePos();
    const modeCol = MODE_COLOR[b.mode];
    // The shot gates grade the tint; the hue stays the mode's.
    const bright = b.targetLOS === true && b.targetInRange ? GATE_BRIGHTNESS.shoot
      : b.targetInRange ? GATE_BRIGHTNESS.range
      : GATE_BRIGHTNESS.track;
    const gateCol: readonly [number, number, number] =
      [modeCol[0] * bright, modeCol[1] * bright, modeCol[2] * bright];
    const t = b.targetEye;
    if (t) push(eye.x, eye.y, eye.z, t.x, t.y, t.z, gateCol);

    // Screen-facing diamond: four segments in the camera's right/up plane, so
    // it presents the same shape from every angle. Scaled by its own distance
    // to hold a constant apparent size.
    const mx = feet.x, my = feet.y + MARKER_HEIGHT, mz = feet.z;
    const s = MARKER_SCALE * Math.hypot(mx - view.eye.x, my - view.eye.y, mz - view.eye.z);
    const rx = view.right.x * s, ry = view.right.y * s, rz = view.right.z * s;
    const ux = view.up.x * s, uy = view.up.y * s, uz = view.up.z * s;
    const corner = (dr: number, du: number): [number, number, number] =>
      [mx + rx * dr + ux * du, my + ry * dr + uy * du, mz + rz * dr + uz * du];
    const [r0, r1, r2, r3] = [corner(1, 0), corner(0, 1), corner(-1, 0), corner(0, -1)];
    push(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], gateCol);
    push(r1[0], r1[1], r1[2], r2[0], r2[1], r2[2], gateCol);
    push(r2[0], r2[1], r2[2], r3[0], r3[1], r3[2], gateCol);
    push(r3[0], r3[1], r3[2], r0[0], r0[1], r0[2], gateCol);
  }
  return v;
}

function build(): THREE.LineSegments {
  positions = new Float32Array(MAX_VERTS * 3);
  colors = new Float32Array(MAX_VERTS * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setDrawRange(0, 0);
  // depthTest off is what makes a route visible THROUGH a wall — the wireframe
  // alone only opens up the walls, not what is drawn behind them. renderOrder
  // puts the lines last so nothing painted afterwards covers them.
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 999;
  lines.frustumCulled = false; // the buffer's bounding sphere is stale by construction
  return lines;
}

/**
 * Flip the level's materials to wireframe (and back).
 *
 * Map builders share a handful of module-level MeshLambertMaterials, so the set
 * is a few entries rather than one per mesh. Bot materials live in bots.ts's own
 * palettes and are deliberately untouched — they must stay solid, or the view
 * hides the very thing it exists to show.
 */
function setXray(on: boolean): void {
  if (on) {
    for (const o of solids) {
      const mesh = o as Partial<THREE.Mesh>;
      if (!mesh.material) continue;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ('wireframe' in m) { (m as THREE.MeshLambertMaterial).wireframe = true; wireframed.add(m); }
      }
    }
    savedFog = scene.fog;
    scene.fog = null; // 40-140 m falloff hides exactly the distant bots this view is for
  } else {
    for (const m of wireframed) (m as THREE.MeshLambertMaterial).wireframe = false;
    wireframed.clear();
    scene.fog = savedFog;
    savedFog = null;
  }
}

/** Flip the overlay on or off. Builds its geometry on first use, not at import. */
export function toggleDebugView(): void {
  session.debugView = !session.debugView;
  if (!overlay) {
    overlay = build();
    scene.add(overlay);
  }
  overlay.visible = session.debugView;
  setXray(session.debugView);
}

/**
 * Rebuild the lines from this frame's bot state. No-op while off.
 *
 * Called from main.ts OUTSIDE the simulate block, so the overlay stays on
 * screen through a pause — the same reason updateEffects lives there. Positions
 * simply stop changing, which is what you want when you hit Esc to study a frame.
 */
export function updateDebugView(): void {
  if (!session.debugView || !overlay || !positions || !colors) return;
  // renderer.render() is what normally refreshes this, and that has not run
  // yet this frame — without the flush the marker would face where the camera
  // pointed last frame.
  camera.updateMatrixWorld();
  const m = camera.matrixWorld.elements;
  basis.right.set(m[0]!, m[1]!, m[2]!);
  basis.up.set(m[4]!, m[5]!, m[6]!);
  basis.eye.copy(camera.position);
  const verts = buildDebugSegments(bots, positions, colors, basis);
  overlay.geometry.setDrawRange(0, verts);
  overlay.geometry.attributes.position!.needsUpdate = true;
  overlay.geometry.attributes.color!.needsUpdate = true;
}
