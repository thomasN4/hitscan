// main.ts — entry point: builds the world, wires all input, owns the game loop.
//
// Flow: parse config query -> initEngine() (imports have no engine/DOM side
// effects) -> BUILDERS[map]() + spawnBots -> initMenus -> register input/pointer-lock
// handlers -> start the render loop.
// The loop only simulates (player, bots, timer) while pointer lock is held;
// rendering and effect updates run always so pause screens stay visible.
// Game time (core/state.ts:gameTime) advances only inside that simulated
// window too — see GameClock in sim/gameClock.ts for why everything
// gameplay-related measures against it.
//
// The per-frame stage order lives in animate() at the bottom of this file
// and is load-bearing — see the comment there before reordering anything.
import type { SessionState, InputState, AimState, WeaponDynamics, MotionState, ScoreState,
               LoadoutState,
               MapName, WeaponSlot, WeaponId, BotWeaponChoice, BotSecondaryChoice, LiveWeapon, PlayerState } from './core/state';
import { initEngine, renderer, scene, camera, clock } from './core/engine';
import { session, input, aim, wpn, motion, score, keys, player, weapon, gameTime, bulletHoles, WEAPONS, bots, loadout, setLoadout, equippedId } from './core/state';
import { parseSessionConfig } from './core/sessionConfig';
import { colliders } from './world';
import { BUILDERS } from './maps';
import { buildNav, route, navGrid } from './nav';
import { updateMovement, updateCamera, updateViewmodel } from './player';
import { spawnBots, updateBots } from './bots';
import { tryReload, switchWeapon, switchToLast, initWeaponViewmodels, updateWeapon } from './weapons';
import { updateEffects } from './effects';
import { toggleDebugView, updateDebugView } from './debugView';
import { respawn, endMatch } from './combat';
import { updateHUD, setTimer, hudEl, setScopeOverlay, initHUD, addKillfeed } from './hud';
import { initMenus, hideAllMenus, showPauseMenu, showLoadoutPicker, readStoredLoadout } from './menu';
import { sfxZoom } from './audio';
import { decideWinner } from './sim/match';
import { validateWeapons } from './sim/validateWeapons';

// ---------- Startup ----------
// Order matters and is deliberately explicit: initEngine() creates the
// renderer/scene/camera that everything below reaches for, so nothing may
// touch those singletons at module scope. Each init* function is safe to
// call exactly once, here.
// core/state.ts stays free of browser globals, so the committed match-config
// query (?map=&tbots=&ctbots=&time=&tweap=&tsec=&ctweap=&ctsec=) is parsed here and written
// into the shared state before anything reads session — initMenus initializes
// the form from it.
Object.assign(session, parseSessionConfig(new URLSearchParams(location.search)));
// Restore the last-deployed loadout (sessionStorage, validated by
// sanitizeLoadout) so this session starts where the previous one deployed.
const storedLoadout = readStoredLoadout();
if (storedLoadout) setLoadout(storedLoadout.primary, storedLoadout.secondary);
score.roundTime = session.roundSeconds;
// Render the configured length once at startup: setTimer otherwise only runs
// inside the locked-only simulate branch, so a fresh load (and the range,
// where it never runs) would show the stale markup default until Play.
setTimer(score.roundTime);
const RANGE = session.map === 'range';

// Loud, not fatal: this runs before initEngine(), so throwing would blank
// the page and hide the message behind a broken app. A violation is a
// mis-tuned constant — the console names weapon, field and consequence,
// and the game still runs.
if (import.meta.env.DEV) {
  for (const v of validateWeapons(Object.values(WEAPONS))) console.error(v);
}

initEngine(session.map);
initHUD();
initWeaponViewmodels();  // needs camera/scene
// Geometry first, then the wave. RANGE stays a separate flag from the builder
// lookup because it means something narrower — "no bots, no round clock" — and
// gates the loop below too; every other map is a full combat map.
BUILDERS[session.map]();
// After the builder, never before: the graph samples world.ts's registries,
// which the builder is what fills. Map switching is a full page reload, so
// this runs once per session.
buildNav();
if (!RANGE) {
  spawnBots(session.botsT, 'T', session.botWeaponT, session.botSecondaryT);
  if (session.botsCt > 0) spawnBots(session.botsCt, 'CT', session.botWeaponCt, session.botSecondaryCt);
}
respawn(); // place player at the map's spawn with fresh HP/ammo/yaw
initMenus({
  onStart: () => showLoadoutPicker('start'),
  onCommit: query => { location.href = location.pathname + query; },
  onResume: lock,
  onQuit: () => { location.reload(); },
  // End screen Rematch: same config query, fresh match — a reload IS the
  // restart, since every slice initializes from defaults at module scope.
  onRematch: () => { location.reload(); },
  // End screen Back to Menu: bare path drops the config query so the start
  // menu opens with SESSION_DEFAULTS.
  onExitToMenu: () => { location.href = location.pathname; },
  // Deploy: commit the picked loadout (the picker saved it to sessionStorage),
  // respawn first when deploying from death, then enter play. The click itself
  // is the user gesture pointer lock needs.
  onDeploy: (primary, secondary) => {
    setLoadout(primary, secondary);
    if (!player.alive) respawn();
    lock();
  },
});

// ---------- Input ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR' && !e.repeat) tryReload();
  // Keys 1/2/3 switch WEAPON POSITIONS (primary/secondary/knife), not specific
  // weapons — 0/1 resolve through the loadout slice; 2 is always the knife.
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  if (e.code === 'Digit3') switchWeapon(2);
  if (e.code === 'KeyQ') switchToLast();
  // DEV bot-observation overlay (debugView.ts). Above the stance gate on
  // purpose: pausing to study a frame is half of what it is for.
  if (import.meta.env.DEV && e.code === 'KeyV') toggleDebugView();
  // Stance keys only count during live play — same gate as the mouse
  // handlers — so nothing toggled pre-lock or behind the pause menu leaks
  // into the session. Sprint is hold-Shift; crouch is a Ctrl/C tap toggle
  // (either side of both), and e.repeat guards against OS key-repeat
  // re-toggling it.
  if (!session.locked || !player.alive) return;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.running = true;
  if ((e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') && !e.repeat) input.crouching = !input.crouching;
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  // Only drop the run when no Shift remains held.
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !keys.ShiftLeft && !keys.ShiftRight) input.running = false;
});
// Losing focus can eat keyup/mouseup events, leaving a held input latched
// across an alt-tab. Drop everything HELD; the crouch toggle is deliberate
// state and persists, exactly like it does through pause.
addEventListener('blur', () => {
  for (const code of Object.keys(keys)) keys[code] = false;
  input.running = false;
  input.shooting = false;
  input.aiming = false;
});

const SENS = 0.0022; // radians per pixel of mouse movement
document.addEventListener('mousemove', e => {
  if (!session.locked || !player.alive) return;
  // zoomScale shrinks toward the FOV ratio while scoped (weapons.ts), so
  // aiming stays controllable at 12x instead of flinging across the sky.
  aim.yaw -= e.movementX * SENS * wpn.zoomScale;
  aim.pitch -= e.movementY * SENS * wpn.zoomScale;
  // Clamp pitch so the player can't flip over backwards
  aim.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, aim.pitch));
});

// Wheel = scope zoom steps, only while scoped with a multi-step-zoom weapon
// (the sniper's zoomFovs). Scroll up zooms in, scroll down zooms out, wrapping
// through the levels; single-entry weapons (iron sights) have nothing to cycle.
addEventListener('wheel', e => {
  if (!session.locked || !player.alive || !input.aiming) return;
  const fovs = WEAPONS[equippedId(wpn.slot)].zoomFovs;
  if (fovs.length < 2) return;
  wpn.zoomLevel = (wpn.zoomLevel + (e.deltaY < 0 ? 1 : -1) + fovs.length) % fovs.length;
  sfxZoom();
});

// LMB = fire (held), RMB = iron sights (held). Buttons are tracked as state
// rather than one-shot events because firing is continuous in updateWeapon.
addEventListener('mousedown', e => {
  if (e.button === 0 && session.locked && player.alive) input.shooting = true;
  // A fresh RMB press can't enter the scope while recoil is still settling
  // (sniper bolt-action feel); a press already held is unaffected.
  if (e.button === 2 && session.locked && player.alive) {
    const gate = WEAPONS[equippedId(wpn.slot)].scopeGate; // undefined = no gate (smg)
    if (gate === undefined || wpn.recoil < gate) input.aiming = true;
  }
});
addEventListener('mouseup', e => {
  if (e.button === 0) input.shooting = false;
  if (e.button === 2) input.aiming = false;
});
addEventListener('contextmenu', e => e.preventDefault()); // RMB must not open the menu

// ---------- Pointer lock / menus ----------
function lock(): void {
  // Chrome's requestPointerLock returns a promise that REJECTS when the
  // browser-enforced cooldown (or headless CI) blocks the request; an
  // unhandled rejection here would surface as a page error. Failure is
  // recoverable — the canvas click handler re-locks — so swallow it.
  try {
    const p = renderer.domElement.requestPointerLock() as unknown;
    if (p instanceof Promise) p.catch(() => { /* cooldown/headless: recovered by canvas click */ });
  } catch { /* same recovery path */ }
}
renderer.domElement.addEventListener('click', () => { if (!session.locked && !session.matchOver && player.alive && session.started) lock(); });

document.addEventListener('pointerlockchange', () => {
  session.locked = document.pointerLockElement === renderer.domElement;
  hudEl.style.display = session.locked ? 'block' : 'none';
  // updateWeapon stops running when the loop pauses; make sure a held scope
  // can't stay stuck on screen across pause/death.
  if (!session.locked) setScopeOverlay(false);
  if (session.locked) {
    session.started = true;
    hideAllMenus();
  } else if (session.matchOver) {
    // endMatch just released the lock: the score screen owns the display
    // (revealed on its own wall-clock beat), never the pause menu.
    showPauseMenu(false);
  } else if (session.started && player.alive) {
    // Losing lock while alive means Esc was pressed -> pause menu.
    // Losing lock while dead is handled by damagePlayer's death screen.
    showPauseMenu(true);
  } else {
    showPauseMenu(false);
  }
});

// ---------- Game loop ----------
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp: tab-switch spikes shouldn't teleport entities

  if (session.locked && session.started) {
    // Stage 0 — advance game time. Every stage below measures against this
    // epoch (fire-rate gates, reloads, respawn timers), and keeping the
    // advance inside the sim block is what makes them all pausable. dt is
    // already clamped, so a tab-switch spike can't fast-forward the
    // scheduler.
    gameTime.advance(dt);

    // Stage order is load-bearing, which is why it lives here rather than
    // nested inside updateMovement. It is pinned from both sides:
    //   - updateMovement writes camera.position, and shoot() (called from
    //     inside updateWeapon) rays from camera.getWorldPosition() — so the
    //     position must be written BEFORE updateWeapon, or every shot leaves
    //     from last frame's eye.
    //   - updateWeapon decays wpn.recoil and recomputes wpn.spread from the
    //     blends updateMovement just wrote; updateCamera and updateViewmodel
    //     then read that post-decay recoil, so they must run AFTER it and the
    //     camera, the viewmodel kick and the bullets all agree within a frame.
    // Moving updateWeapon after updateCamera aims the camera one frame ahead
    // of the shots (see `5e004a5`).
    updateMovement(dt);
    updateWeapon(dt);
    updateCamera();
    updateViewmodel();
    if (!RANGE) updateBots(dt, player);

    // Round clock: arena only — meaningless on the range, so freeze it there.
    // Clamped at 0 rather than reset: expiry ENDS the match (combat.ts:endMatch),
    // winner by kill score (sim/match.ts:decideWinner). The matchOver check is
    // redundant with the lock gate in the normal flow (endMatch releases the
    // pointer), but keeps a same-frame double-fire impossible if lock release
    // ever becomes async.
    if (!RANGE) {
      score.roundTime = Math.max(0, score.roundTime - dt);
      setTimer(score.roundTime);
      if (score.roundTime <= 0 && !session.matchOver) {
        addKillfeed('⏱ Time expired');
        endMatch(decideWinner(score.scoreKills, score.scoreDeaths));
      }
    }

    updateHUD();
  }

  // Effects keep fading while paused so impacts don't freeze on screen
  updateEffects(dt);
  // Outside the simulate block for the same reason, and after updateBots so
  // the lines match this frame's positions rather than the previous one's.
  if (import.meta.env.DEV) updateDebugView();
  renderer.render(scene, camera);
}
animate();

// Debug/testing hook: inspect live state from devtools (`__cs.game`, ...)
// or from scripts/smoke-test.mjs.
//
// `game` below is a delegation-only FACADE over the owner-scoped slices from
// core/state.ts (session/input/aim/wpn/motion/score). It exists purely to
// keep this hook's historical flat shape — the AGENTS.md invariant and the
// smoke test both read `__cs.game.x` — and holds no state of its own:
// every access round-trips to a slice. Gameplay code imports the slices
// directly; do not route logic through this object.
type DebugGame = SessionState & InputState & AimState & Omit<WeaponDynamics, 'reloadSfxHandle'> & MotionState & ScoreState & LoadoutState;

const game: DebugGame = {
  get map() { return session.map; }, set map(v: MapName) { session.map = v; },
  get primary() { return loadout.primary; }, set primary(v: WeaponId) { loadout.primary = v; },
  get secondary() { return loadout.secondary; }, set secondary(v: WeaponId) { loadout.secondary = v; },
  get botsT() { return session.botsT; }, set botsT(v: number) { session.botsT = v; },
  get botsCt() { return session.botsCt; }, set botsCt(v: number) { session.botsCt = v; },
  get roundSeconds() { return session.roundSeconds; }, set roundSeconds(v: number) { session.roundSeconds = v; },
  get botWeaponT() { return session.botWeaponT; }, set botWeaponT(v: BotWeaponChoice) { session.botWeaponT = v; },
  get botWeaponCt() { return session.botWeaponCt; }, set botWeaponCt(v: BotWeaponChoice) { session.botWeaponCt = v; },
  get botSecondaryT() { return session.botSecondaryT; }, set botSecondaryT(v: BotSecondaryChoice) { session.botSecondaryT = v; },
  get botSecondaryCt() { return session.botSecondaryCt; }, set botSecondaryCt(v: BotSecondaryChoice) { session.botSecondaryCt = v; },
  get locked() { return session.locked; }, set locked(v: boolean) { session.locked = v; },
  get started() { return session.started; }, set started(v: boolean) { session.started = v; },
  get debugView() { return session.debugView; }, set debugView(v: boolean) { session.debugView = v; },
  get matchOver() { return session.matchOver; }, set matchOver(v: boolean) { session.matchOver = v; },
  get shooting() { return input.shooting; }, set shooting(v: boolean) { input.shooting = v; },
  get aiming() { return input.aiming; }, set aiming(v: boolean) { input.aiming = v; },
  get running() { return input.running; }, set running(v: boolean) { input.running = v; },
  get crouching() { return input.crouching; }, set crouching(v: boolean) { input.crouching = v; },
  get yaw() { return aim.yaw; }, set yaw(v: number) { aim.yaw = v; },
  get pitch() { return aim.pitch; }, set pitch(v: number) { aim.pitch = v; },
  get spread() { return wpn.spread; }, set spread(v: number) { wpn.spread = v; },
  get spray() { return wpn.spray; }, set spray(v: number) { wpn.spray = v; },
  get recoil() { return wpn.recoil; }, set recoil(v: number) { wpn.recoil = v; },
  get recoilYaw() { return wpn.recoilYaw; }, set recoilYaw(v: number) { wpn.recoilYaw = v; },
  get adsLerp() { return wpn.adsLerp; }, set adsLerp(v: number) { wpn.adsLerp = v; },
  get slot() { return wpn.slot; }, set slot(v: WeaponSlot) { wpn.slot = v; },
  get lastSlot() { return wpn.lastSlot; }, set lastSlot(v: WeaponSlot) { wpn.lastSlot = v; },
  get zoomLevel() { return wpn.zoomLevel; }, set zoomLevel(v: number) { wpn.zoomLevel = v; },
  get zoomScale() { return wpn.zoomScale; }, set zoomScale(v: number) { wpn.zoomScale = v; },
  get triggerLatch() { return wpn.triggerLatch; }, set triggerLatch(v: boolean) { wpn.triggerLatch = v; },
  get emptyReloadLatch() { return wpn.emptyReloadLatch; }, set emptyReloadLatch(v: boolean) { wpn.emptyReloadLatch = v; },
  get runLerp() { return motion.runLerp; }, set runLerp(v: number) { motion.runLerp = v; },
  get moveLerp() { return motion.moveLerp; }, set moveLerp(v: number) { motion.moveLerp = v; },
  get crouchLerp() { return motion.crouchLerp; }, set crouchLerp(v: number) { motion.crouchLerp = v; },
  get groundSmoothY() { return motion.groundSmoothY; }, set groundSmoothY(v: number) { motion.groundSmoothY = v; },
  get airLerp() { return motion.airLerp; }, set airLerp(v: number) { motion.airLerp = v; },
  get stepTimer() { return motion.stepTimer; }, set stepTimer(v: number) { motion.stepTimer = v; },
  get bobAmt() { return motion.bobAmt; }, set bobAmt(v: number) { motion.bobAmt = v; },
  get scoreKills() { return score.scoreKills; }, set scoreKills(v: number) { score.scoreKills = v; },
  get scoreDeaths() { return score.scoreDeaths; }, set scoreDeaths(v: number) { score.scoreDeaths = v; },
  get playerKills() { return score.playerKills; }, set playerKills(v: number) { score.playerKills = v; },
  get playerDeaths() { return score.playerDeaths; }, set playerDeaths(v: number) { score.playerDeaths = v; },
  get roundTime() { return score.roundTime; }, set roundTime(v: number) { score.roundTime = v; },
};

declare global {
  interface Window {
    __cs: {
      game: DebugGame;
      weapon: LiveWeapon;
      player: PlayerState;
      bots: typeof bots;
      bulletHoles: typeof bulletHoles;
      colliders: typeof colliders;
      /** The pausable gameplay clock — lets devtools/smoke tests read (never advance) match time. */
      gameTime: typeof gameTime;
      /**
       * Navigation graph queries. The graph is the one part of the AI whose
       * correctness can be checked without watching a bot move, so the smoke
       * test asks it directly whether the deck is reachable from the floor.
       */
      nav: { route: typeof route; grid: typeof navGrid };
    };
  }
}
window.__cs = { game, weapon, player, bots, bulletHoles, colliders, gameTime, nav: { route, grid: navGrid } };
