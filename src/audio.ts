// audio.ts — all sound effects, synthesized at runtime with WebAudio.
//
// No asset files: gunshots/steps are filtered noise bursts, the hurt sound
// is a pitch-swept oscillator. If you add a new sound, follow the same
// pattern — create nodes per playback and let them be garbage-collected
// (do NOT reuse buffers across sounds; each call builds its own).
// `import type` because only THREE.Vector3's TYPE is used here — without it
// the reference resolved through @types/three's `export as namespace THREE`
// UMD alias, which is legal in type position but silently ties this file to a
// declaration detail of the types package. Erased under verbatimModuleSyntax.
import type * as THREE from 'three';
import { camera } from './core/engine';
import { gameTime } from './core/state';

let audioCtx: AudioContext | undefined;
function ac() {
  // Lazily created on first sound; browsers require a user gesture first,
  // which is guaranteed because the game only starts after clicking Play.
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** White-noise buffer of `dur` seconds. */
function noiseBuffer(ctx: AudioContext, dur: number): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Generic noise-burst "gunshot": lowpass sweep from `freqBase` down to
 * 100 Hz over `dur` gives the punchy decay. Volume/frequency/duration
 * variations produce every distinct weapon-ish sound in the game.
 */
function playGunshot(vol = 0.35, freqBase = 900, dur = 0.12): void {
  const ctx = ac();
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freqBase, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

export const sfxShoot = (): void => playGunshot(0.4, 1400, 0.14);

/** Sniper: deeper boom with a longer tail than the smg crack. */
export const sfxSniper = (): void => playGunshot(0.5, 500, 0.3);

/** Shotgun: big low boom, longer tail — a powder charge, not a cartridge crack. */
export const sfxShotgun = (): void => playGunshot(0.55, 380, 0.28);

/** Pistol: sharper, shorter crack than the smg burst. */
export const sfxPistol = (): void => playGunshot(0.35, 1100, 0.09);

/** Revolver: louder, fuller bark than the pistol — more powder, longer barrel. */
export const sfxRevolver = (): void => playGunshot(0.48, 750, 0.18);

/** Weapon switch: short metallic click. */
export const sfxSwitch = (): void => playGunshot(0.1, 1800, 0.04);

/** Scope zoom step: even softer tick. */
export const sfxZoom = (): void => playGunshot(0.08, 2400, 0.03);

/** Enemy gunshot: quieter, attenuated with distance from the camera. */
export function sfxEnemyShoot(pos: THREE.Vector3): void {
  const d = camera.position.distanceTo(pos);
  playGunshot(Math.max(0.05, 0.3 - d / 150), 700, 0.1);
}

/**
 * Three clicks approximating mag-out / mag-in / bolt. Timed to reloadTime,
 * scheduled on the GAME clock so they freeze if the reload pauses — the
 * sounds stay in sync with the animation instead of playing over a
 * suspended one.
 */
export function sfxReload(): void {
  playGunshot(0.12, 500, 0.06);   // click 1: immediately
  gameTime.schedule(0.25, () => playGunshot(0.12, 800, 0.06));    // click 2
  gameTime.schedule(1.1, () => playGunshot(0.15, 1000, 0.08));  // final clack (~halfway through 2.2s reload)
}

/** Soft footstep; randomized pitch/level so repeats don't sound mechanical. */
export function sfxFootstep(): void {
  const ctx = ac();
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.09);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(300 + Math.random() * 150, ctx.currentTime);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12 + Math.random() * 0.05, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

/** Player hurt: descending sawtooth "grunt". */
export function sfxHurt(): void {
  const ctx = ac();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(220, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.15);
  g.gain.setValueAtTime(0.15, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.15);
}
