// touchControls.ts — on-screen controls for touch mode, after Critical Ops'
// Android layout: a floating movement stick on the left, a look surface
// covering the right, a draggable fire button (fire AND aim with one thumb),
// a second fire button above the stick, and tap buttons for ADS, zoom, jump,
// crouch, reload, weapon positions and pause.
//
// Owns everything inside #touchControls (markup in index.html, inside #hud,
// so it shows and hides with the HUD — i.e. only during live play). This is
// the third sanctioned DOM writer beside hud.ts and menu.ts, confined to that
// subtree; ids go through hud.ts:requireEl like every other lookup.
//
// It writes the same slices the mouse/keyboard handlers in main.ts write —
// input, aim, keys — and calls the same weapon entry points, so nothing
// downstream knows which device produced an action. The stick geometry and
// the look math are pure (sim/joystick.ts, sim/look.ts); this module only
// binds pointer events to them.
//
// Every finger is tracked by pointerId, because the whole point of the layout
// is several at once: stick + look, stick + left fire, fire-drag + ADS tap.
import { input, aim, wpn, keys, session, player, WEAPONS, equippedId, type WeaponSlot } from './core/state';
import { tryReload, switchWeapon, tryRaiseSights, cycleZoom } from './weapons';
import { releasePlay } from './playControl';
import { requireEl } from './hud';
import { stickVector } from './sim/joystick';
import { applyLook } from './sim/look';

/** Radians per CSS pixel of finger travel — a ~700 px swipe turns about 180°. */
const TOUCH_SENS = 0.0045;
/** Stick radius in CSS px: how far the knob travels before it clamps. */
const STICK_RADIUS = 56;

const SLOTS: readonly WeaponSlot[] = [0, 1, 2];

let stickBase: HTMLElement, stickKnob: HTMLElement,
  adsBtn: HTMLElement, zoomBtn: HTMLElement, crouchBtn: HTMLElement;
const slotBtns: HTMLElement[] = [];

/** The finger driving the stick, and where it first landed. */
let stick: { id: number; x: number; y: number } | null = null;
/** Every finger currently turning the view (look surface or right fire button), by last position. */
const lookers = new Map<number, { x: number; y: number }>();
/** Fingers holding either fire button; firing stops when the last lifts. */
const firing = new Set<number>();

function live(): boolean {
  return session.locked && player.alive;
}

/**
 * Drop every held touch input: stick centred, fire and sprint released,
 * jump let go, all tracked fingers forgotten. Called on release of play
 * (pause, death, match end) and on window blur. The crouch and ADS toggles
 * are deliberate state and persist, like Ctrl/C's toggle does through pause.
 */
export function resetTouchInput(): void {
  stick = null;
  lookers.clear();
  firing.clear();
  input.moveX = 0;
  input.moveY = 0;
  input.running = false;
  input.shooting = false;
  keys.Space = false;
  stickBase.style.display = 'none';
}

/** Bind pointerdown to `el`, capture the pointer so its move/up events follow it off the element. */
function onPress(el: HTMLElement, fn: (e: PointerEvent) => void): void {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    fn(e);
  });
}

/** One-shot tap button: fires on press, while live. */
function tapButton(id: string, fn: () => void): HTMLElement {
  const el = requireEl(id);
  onPress(el, () => { if (live()) fn(); });
  return el;
}

function moveStick(e: PointerEvent): void {
  if (!stick || e.pointerId !== stick.id) return;
  const r = stickVector(e.clientX - stick.x, e.clientY - stick.y, STICK_RADIUS);
  input.moveX = r.x;
  input.moveY = r.y;
  input.running = r.sprint;
  stickKnob.style.transform = `translate(${r.knobX}px, ${r.knobY}px)`;
}

function endStick(e: PointerEvent): void {
  if (!stick || e.pointerId !== stick.id) return;
  stick = null;
  input.moveX = 0;
  input.moveY = 0;
  input.running = false;
  stickBase.style.display = 'none';
}

function moveLook(e: PointerEvent): void {
  const last = lookers.get(e.pointerId);
  if (!last) return;
  if (live()) {
    const next = applyLook(aim.yaw, aim.pitch, e.clientX - last.x, e.clientY - last.y, TOUCH_SENS, wpn.zoomScale);
    aim.yaw = next.yaw;
    aim.pitch = next.pitch;
  }
  last.x = e.clientX;
  last.y = e.clientY;
}

function endFinger(e: PointerEvent): void {
  lookers.delete(e.pointerId);
  if (firing.delete(e.pointerId) && firing.size === 0) input.shooting = false;
}

/** Resolve the markup and bind every control. Call once, touch mode only, after initHUD. */
export function initTouchControls(): void {
  const root = requireEl('touchControls');
  root.style.display = 'block';
  stickBase = requireEl('tcStickBase');
  stickKnob = requireEl('tcStickKnob');

  // Movement stick: floats to wherever the thumb lands in its zone.
  const stickZone = requireEl('tcStickZone');
  onPress(stickZone, e => {
    if (!live() || stick) return;
    stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stickBase.style.left = `${e.clientX}px`;
    stickBase.style.top = `${e.clientY}px`;
    stickKnob.style.transform = 'translate(0px, 0px)';
    stickBase.style.display = 'block';
  });
  stickZone.addEventListener('pointermove', moveStick);
  stickZone.addEventListener('pointerup', endStick);
  stickZone.addEventListener('pointercancel', endStick);

  // Look surface: every finger on it turns the view by its own delta.
  const lookZone = requireEl('tcLook');
  onPress(lookZone, e => { lookers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });

  // Right fire: fires AND turns the view while dragged. Left fire: fires only.
  const fireR = requireEl('tcFire');
  onPress(fireR, e => {
    lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!live()) return;
    firing.add(e.pointerId);
    input.shooting = true;
  });
  const fireL = requireEl('tcFireL');
  onPress(fireL, e => {
    if (!live()) return;
    firing.add(e.pointerId);
    input.shooting = true;
  });
  for (const el of [lookZone, fireR, fireL]) {
    el.addEventListener('pointermove', moveLook);
    el.addEventListener('pointerup', endFinger);
    el.addEventListener('pointercancel', endFinger);
  }

  // ADS is a tap toggle. Every writer that drops input.aiming (unscope on
  // shot, reload start, swap) drops the toggle with it, no special case.
  adsBtn = tapButton('tcAds', () => {
    if (input.aiming) input.aiming = false;
    else tryRaiseSights();
  });
  zoomBtn = tapButton('tcZoom', () => cycleZoom(1));
  crouchBtn = tapButton('tcCrouch', () => { input.crouching = !input.crouching; });
  tapButton('tcReload', tryReload);

  // Jump is held, not tapped: player.ts reads keyHeld('Space') while grounded.
  const jump = requireEl('tcJump');
  onPress(jump, () => { if (live()) keys.Space = true; });
  const release = (): void => { keys.Space = false; };
  jump.addEventListener('pointerup', release);
  jump.addEventListener('pointercancel', release);

  for (const slot of SLOTS) {
    slotBtns.push(tapButton(`tcSlot${slot}`, () => switchWeapon(slot)));
  }

  // Pause is the touch Esc: live-gated only on lock, so it works while dead
  // frames drain too (releasePlay ignores a repeat).
  onPress(requireEl('tcPause'), () => { if (session.locked) releasePlay(); });
}

// Per-frame view sync, cached so unchanged values don't touch the DOM.
let shownSlot: WeaponSlot | null = null;
let shownNames = '';
let shownAds: boolean | null = null;
let shownZoom: boolean | null = null;
let shownCrouch: boolean | null = null;

/** Reflect live state onto the controls. Called from animate() after updateHUD, touch mode only. */
export function updateTouchControls(): void {
  const names = SLOTS.map(s => WEAPONS[equippedId(s)].name);
  const joined = names.join('|');
  if (joined !== shownNames) {
    shownNames = joined;
    // SLOTS and slotBtns are built together, one button per slot.
    names.forEach((n, i) => { slotBtns[i]!.textContent = n; });
  }
  if (wpn.slot !== shownSlot) {
    shownSlot = wpn.slot;
    slotBtns.forEach((b, i) => b.classList.toggle('active', i === wpn.slot));
  }
  if (input.aiming !== shownAds) {
    shownAds = input.aiming;
    adsBtn.classList.toggle('active', input.aiming);
  }
  const zoomable = input.aiming && WEAPONS[equippedId(wpn.slot)].zoomFovs.length > 1;
  if (zoomable !== shownZoom) {
    shownZoom = zoomable;
    zoomBtn.style.display = zoomable ? 'flex' : 'none';
  }
  if (input.crouching !== shownCrouch) {
    shownCrouch = input.crouching;
    crouchBtn.classList.toggle('active', input.crouching);
  }
}
