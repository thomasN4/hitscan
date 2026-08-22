// audio.js — all sound effects, synthesized at runtime with WebAudio.
//
// No asset files: gunshots/steps are filtered noise bursts, the hurt sound
// is a pitch-swept oscillator. If you add a new sound, follow the same
// pattern — create nodes per playback and let them be garbage-collected
// (do NOT reuse buffers across sounds; each call builds its own).
import { camera } from './core.js';

let audioCtx;
function ac() {
  // Lazily created on first sound; browsers require a user gesture first,
  // which is guaranteed because the game only starts after clicking Play.
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** White-noise buffer of `dur` seconds. */
function noiseBuffer(ctx, dur) {
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
function playGunshot(vol = 0.35, freqBase = 900, dur = 0.12) {
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

export const sfxShoot = () => playGunshot(0.4, 1400, 0.14);

/** Sniper: deeper boom with a longer tail than the smg crack. */
export const sfxSniper = () => playGunshot(0.5, 500, 0.3);

/** Weapon switch: short metallic click. */
export const sfxSwitch = () => playGunshot(0.1, 1800, 0.04);

/** Scope zoom step: even softer tick. */
export const sfxZoom = () => playGunshot(0.08, 2400, 0.03);

/** Enemy gunshot: quieter, attenuated with distance from the camera. */
export function sfxEnemyShoot(pos) {
  const d = camera.position.distanceTo(pos);
  playGunshot(Math.max(0.05, 0.3 - d / 150), 700, 0.1);
}

/** Three clicks approximating mag-out / mag-in / bolt. Timed to reloadTime. */
export function sfxReload() {
  playGunshot(0.12, 500, 0.06);   // click 1: immediately
  setTimeout(() => playGunshot(0.12, 800, 0.06), 250);    // click 2
  setTimeout(() => playGunshot(0.15, 1000, 0.08), 1100);  // final clack (~halfway through 2.2s reload)
}

/** Soft footstep; randomized pitch/level so repeats don't sound mechanical. */
export function sfxFootstep() {
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
export function sfxHurt() {
  const ctx = ac();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(220, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.15);
  g.gain.setValueAtTime(0.15, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.15);
}
