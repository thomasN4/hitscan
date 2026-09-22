// touchControls.ts — on-screen controls for touch mode, after Critical Ops'
// Android layout: a floating movement stick on the left, a look surface
// covering the right, a draggable fire button (fire AND aim with one thumb),
// a second fire button above the stick, and tap buttons for ADS, zoom, jump,
// crouch, reload, weapon positions and pause.
//
// Owns everything inside #touchControls, a top-level layer in index.html that
// this module shows during live play (setTouchControlsShown, driven by
// main.ts's play-capture handler) and in the layout editor. This is a
// sanctioned DOM writer beside hud.ts and menu.ts, confined to that subtree;
// ids go through hud.ts:requireEl like every other lookup.
//
// Where each control sits, how big it is, how opaque, the stick's travel and
// the look feel all come from core/state.ts:settings (the player's, edited in
// settingsMenu.ts). The layout editor below edits a DRAFT of settings.layout
// and hands it back; it never writes the slice itself.
//
// It writes the same slices the mouse/keyboard handlers in main.ts write —
// input, aim, keys — and calls the same weapon entry points, so nothing
// downstream knows which device produced an action. The stick geometry and
// the look math are pure (sim/joystick.ts, sim/look.ts); this module only
// binds pointer events to them.
//
// Every finger is tracked by pointerId, because the whole point of the layout
// is several at once: stick + look, stick + left fire, fire-drag + ADS tap.
import { input, aim, wpn, keys, session, player, settings, WEAPONS, equippedId, type WeaponSlot } from './core/state';
import { TOUCH_CONTROL_IDS, SETTING_LIMITS, defaultLayout, type TouchControlId, type TouchLayout, type ControlPlacement } from './core/settings';
import { tryReload, switchWeapon, tryRaiseSights, cycleZoom } from './weapons';
import { releasePlay } from './playControl';
import { requireEl } from './hud';
import { stickVector } from './sim/joystick';
import { applyLook, accelGain, blendLook, TOUCH_BASE_SENS } from './sim/look';

/**
 * Least time step (ms) the look speed is measured over. Touch events can
 * arrive a hair apart (or share a timestamp); an unfloored dt would read a
 * 2 px jitter as a flick and throw acceleration at it.
 */
const MIN_LOOK_DT_MS = 4;

/** Markup id of each movable control; a full Record, so a new TouchControlId needs its element named. */
const CONTROL_EL: Record<TouchControlId, string> = {
  fireR: 'tcFire', fireL: 'tcFireL', ads: 'tcAds', zoom: 'tcZoom', reload: 'tcReload',
  jump: 'tcJump', crouch: 'tcCrouch', pause: 'tcPause', weapons: 'tcWeapons',
};

const SLOTS: readonly WeaponSlot[] = [0, 1, 2];

let root: HTMLElement, buttons: HTMLElement, stickBase: HTMLElement, stickKnob: HTMLElement,
  adsBtn: HTMLElement, zoomBtn: HTMLElement, crouchBtn: HTMLElement;
const controlEls = {} as Record<TouchControlId, HTMLElement>;
const slotBtns: HTMLElement[] = [];

/** The finger driving the stick, and where it first landed. */
let stick: { id: number; x: number; y: number } | null = null;
/** Every finger currently turning the view (look surface or right fire button), by last position and event time. */
const lookers = new Map<number, { x: number; y: number; t: number }>();
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
  const r = stickVector(e.clientX - stick.x, e.clientY - stick.y, settings.touch.stickRadius);
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
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    const speed = Math.hypot(dx, dy) / Math.max(e.timeStamp - last.t, MIN_LOOK_DT_MS) * 1000;
    // Hip and ADS tunings blend with the sights' raise, so the feel eases
    // over rather than snapping mid-drag; zoomScale still applies on top.
    const tune = blendLook(settings.touch.hip, settings.touch.ads, wpn.adsLerp);
    const sens = TOUCH_BASE_SENS * tune.sens * accelGain(speed, tune.accel);
    const next = applyLook(aim.yaw, aim.pitch, dx, dy, sens, wpn.zoomScale);
    aim.yaw = next.yaw;
    aim.pitch = next.pitch;
  }
  last.x = e.clientX;
  last.y = e.clientY;
  last.t = e.timeStamp;
}

function place(el: HTMLElement, p: ControlPlacement): void {
  el.style.setProperty('--x', String(p.x));
  el.style.setProperty('--y', String(p.y));
  el.style.setProperty('--s', String(p.scale));
}

function placeAll(layout: TouchLayout): void {
  for (const id of TOUCH_CONTROL_IDS) place(controlEls[id], layout[id]);
}

/**
 * Apply settings.touch and settings.layout to the controls: positions,
 * sizes, opacity and the stick's drawn size. Called at init and by the
 * settings menu after every change.
 */
export function applyTouchSettings(): void {
  placeAll(settings.layout);
  // On the controls, not the root: the editor's backdrop and toolbar live in
  // the root and must stay legible at any opacity.
  buttons.style.opacity = stickBase.style.opacity = String(settings.touch.opacity);
  const r = settings.touch.stickRadius;
  stickBase.style.width = stickBase.style.height = `${2 * r}px`;
  stickBase.style.margin = `${-r}px 0 0 ${-r}px`;
  const k = Math.round(0.9 * r);
  stickKnob.style.width = stickKnob.style.height = `${k}px`;
  stickKnob.style.margin = `${-k / 2}px 0 0 ${-k / 2}px`;
}

/** Show the controls during live play only (the layout editor shows them itself). */
export function setTouchControlsShown(on: boolean): void {
  if (editing) return;
  root.style.display = on ? 'block' : 'none';
}

function endFinger(e: PointerEvent): void {
  lookers.delete(e.pointerId);
  if (firing.delete(e.pointerId) && firing.size === 0) input.shooting = false;
}

/** Resolve the markup and bind every control. Call once, touch mode only, after initHUD. */
export function initTouchControls(): void {
  root = requireEl('touchControls');
  buttons = requireEl('tcButtons');
  for (const id of TOUCH_CONTROL_IDS) controlEls[id] = requireEl(CONTROL_EL[id]);
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
  onPress(lookZone, e => { lookers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); });

  // Right fire: fires AND turns the view while dragged. Left fire: fires only.
  const fireR = requireEl('tcFire');
  onPress(fireR, e => {
    lookers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
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

  initLayoutEditor();
  applyTouchSettings();
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
  const zoomable = editing || (input.aiming && WEAPONS[equippedId(wpn.slot)].zoomFovs.length > 1);
  if (zoomable !== shownZoom) {
    shownZoom = zoomable;
    zoomBtn.style.display = zoomable ? 'flex' : 'none';
  }
  if (input.crouching !== shownCrouch) {
    shownCrouch = input.crouching;
    crouchBtn.classList.toggle('active', input.crouching);
  }
}

// ---------- Layout editor ----------
// Started from the settings screen. Shows the controls above every menu and
// lets the player drag each one and resize the selected one. Play is released
// while any menu is up, so every gameplay handler above is already inert
// (live() is false); the editor's CAPTURE-phase listeners on the root also
// stop presses before they reach those handlers at all, except on the
// toolbar, whose own buttons and slider must work normally.

let editing = false;
let draft: TouchLayout = defaultLayout();
let selected: TouchControlId | null = null;
let drag: { id: number; ctl: TouchControlId; dx: number; dy: number } | null = null;
let onEditDone: (layout: TouchLayout | null) => void = () => { /* set by startLayoutEdit */ };
let editBar: HTMLElement, editName: HTMLElement, editSize: HTMLInputElement, editSizeOut: HTMLElement;

const CONTROL_LABEL: Record<TouchControlId, string> = {
  fireR: 'Fire (right)', fireL: 'Fire (left)', ads: 'ADS', zoom: 'Zoom', reload: 'Reload',
  jump: 'Jump', crouch: 'Crouch', pause: 'Pause', weapons: 'Weapons',
};

function controlAt(target: EventTarget | null): TouchControlId | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-ctl]');
  const id = el?.dataset.ctl;
  return id !== undefined && (TOUCH_CONTROL_IDS as readonly string[]).includes(id) ? id as TouchControlId : null;
}

function select(id: TouchControlId | null): void {
  if (selected) controlEls[selected].classList.remove('tc-selected');
  selected = id;
  editSize.disabled = id === null;
  if (id === null) {
    editName.textContent = 'tap one to resize';
    editSizeOut.textContent = '\u2013';
    return;
  }
  controlEls[id].classList.add('tc-selected');
  editName.textContent = CONTROL_LABEL[id];
  editSize.value = String(draft[id].scale);
  editSizeOut.textContent = `${Math.round(draft[id].scale * 100)}%`;
}

/**
 * Keep a control wholly inside the safe area: a centre closer to an edge
 * than half the control's (scaled) size is pulled back in.
 */
function clampPlacement(ctl: TouchControlId, x: number, y: number): { x: number; y: number } {
  const area = buttons.getBoundingClientRect();
  const r = controlEls[ctl].getBoundingClientRect();
  const hx = Math.min(0.5, r.width / 2 / area.width), hy = Math.min(0.5, r.height / 2 / area.height);
  return { x: Math.min(1 - hx, Math.max(hx, x)), y: Math.min(1 - hy, Math.max(hy, y)) };
}

function initLayoutEditor(): void {
  editBar = requireEl('tcEditBar');
  editName = requireEl('tcEditName');
  editSize = requireEl('tcEditSize') as HTMLInputElement;
  editSizeOut = requireEl('tcEditSizeOut');
  editSize.min = String(SETTING_LIMITS.scale.min);
  editSize.max = String(SETTING_LIMITS.scale.max);

  root.addEventListener('pointerdown', e => {
    if (!editing || editBar.contains(e.target as Node)) return;
    e.stopPropagation();
    e.preventDefault();
    const ctl = controlAt(e.target);
    select(ctl);
    if (ctl === null) return;
    const area = buttons.getBoundingClientRect();
    // Grab offset, so the control does not jump its centre to the finger.
    drag = {
      id: e.pointerId, ctl,
      dx: (e.clientX - area.left) / area.width - draft[ctl].x,
      dy: (e.clientY - area.top) / area.height - draft[ctl].y,
    };
    root.setPointerCapture(e.pointerId);
  }, { capture: true });
  root.addEventListener('pointermove', e => {
    if (!editing || !drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const area = buttons.getBoundingClientRect();
    const p = draft[drag.ctl];
    const at = clampPlacement(drag.ctl,
      (e.clientX - area.left) / area.width - drag.dx,
      (e.clientY - area.top) / area.height - drag.dy);
    p.x = +at.x.toFixed(3);
    p.y = +at.y.toFixed(3);
    place(controlEls[drag.ctl], p);
  }, { capture: true });
  const endDrag = (e: PointerEvent): void => {
    if (!editing || !drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    drag = null;
  };
  root.addEventListener('pointerup', endDrag, { capture: true });
  root.addEventListener('pointercancel', endDrag, { capture: true });

  editSize.addEventListener('input', () => {
    if (selected === null) return;
    const p = draft[selected];
    p.scale = Number(editSize.value);
    editSizeOut.textContent = `${Math.round(p.scale * 100)}%`;
    place(controlEls[selected], p);
    // A grown control may now overhang the edge; pull it back in.
    const at = clampPlacement(selected, p.x, p.y);
    p.x = +at.x.toFixed(3);
    p.y = +at.y.toFixed(3);
    place(controlEls[selected], p);
  });
  requireEl('tcEditReset').onclick = () => {
    draft = defaultLayout();
    placeAll(draft);
    select(selected);
  };
  requireEl('tcEditCancel').onclick = () => finishLayoutEdit(null);
  requireEl('tcEditDone').onclick = () => finishLayoutEdit(draft);
}

/**
 * Open the editor over the current menus. `done` receives the edited layout
 * (Done) or null (Cancel); the caller owns saving it into settings.
 */
export function startLayoutEdit(done: (layout: TouchLayout | null) => void): void {
  onEditDone = done;
  draft = structuredClone(settings.layout);
  editing = true;
  root.classList.add('editing');
  root.style.display = 'block';
  zoomBtn.style.display = 'flex';
  shownZoom = null;
  select(null);
}

function finishLayoutEdit(layout: TouchLayout | null): void {
  select(null);
  drag = null;
  editing = false;
  root.classList.remove('editing');
  root.style.display = session.locked ? 'block' : 'none';
  zoomBtn.style.display = 'none';
  shownZoom = null;
  placeAll(settings.layout);
  onEditDone(layout);
}
