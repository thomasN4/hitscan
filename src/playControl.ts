// playControl.ts — entering and leaving live play, on desktop and on touch.
//
// The loop simulates only while play input is captured (session.locked). On
// desktop that capture IS pointer lock: enterPlay() requests it and the
// browser's pointerlockchange reports the outcome, asynchronously. Touch
// browsers have no pointer lock at all, so in touch mode capture is a plain
// flag this module flips — synchronously — and reports through the SAME
// callback, so main.ts's HUD/menu branching has exactly one path for both.
//
// Browser-only. initPlayControl() is called once by main.ts after
// initEngine() (it needs the canvas); combat.ts's death and match-end
// releases come through releasePlay() rather than document.exitPointerLock(),
// which would be a silent no-op in touch mode and leave the sim running
// behind the death screen.
import { parseTouchOverride } from './core/sessionConfig';

let touchMode = false;
/** Touch-mode capture flag; desktop reads the browser's pointerLockElement instead. */
let touchCaptured = false;
let target: HTMLElement;
let onChange: (captured: boolean) => void = () => { /* set by initPlayControl */ };

/**
 * Whether this page runs touch controls: `?touch=1`/`?touch=0` wins, else a
 * coarse primary pointer (phones, tablets — not a touchscreen laptop, whose
 * primary pointer is still the trackpad).
 */
export function detectTouchMode(search: string): boolean {
  return parseTouchOverride(new URLSearchParams(search).get('touch'))
    ?? matchMedia('(pointer: coarse)').matches;
}

export function isTouchMode(): boolean {
  return touchMode;
}

/**
 * Wire capture changes to `cb`. Desktop listens for pointerlockchange on
 * `canvas`; touch mode additionally releases when the page is hidden (an app
 * switch or a locked screen), which on desktop pointer lock already does.
 */
export function initPlayControl(canvas: HTMLElement, touch: boolean, cb: (captured: boolean) => void): void {
  target = canvas;
  touchMode = touch;
  onChange = cb;
  if (touchMode) {
    document.addEventListener('visibilitychange', () => { if (document.hidden) releasePlay(); });
  } else {
    document.addEventListener('pointerlockchange', () => onChange(document.pointerLockElement === target));
  }
}

/** Capture play input. Must run inside a user gesture on desktop (pointer lock requires one). */
export function enterPlay(): void {
  if (touchMode) {
    setTouchCaptured(true);
    return;
  }
  // Chrome's requestPointerLock returns a promise that REJECTS when the
  // browser-enforced cooldown (or headless CI) blocks the request; an
  // unhandled rejection here would surface as a page error. Failure is
  // recoverable — the canvas click handler re-locks — so swallow it.
  try {
    const p = target.requestPointerLock() as unknown;
    if (p instanceof Promise) p.catch(() => { /* cooldown/headless: recovered by canvas click */ });
  } catch { /* same recovery path */ }
}

/** Release play input: pause, death, match end. */
export function releasePlay(): void {
  if (touchMode) {
    setTouchCaptured(false);
    return;
  }
  document.exitPointerLock();
}

/**
 * Report only real transitions, as pointerlockchange does: a page hide while
 * a menu is already up must not re-run the pause branching behind it.
 */
function setTouchCaptured(captured: boolean): void {
  if (captured === touchCaptured) return;
  touchCaptured = captured;
  onChange(captured);
}
