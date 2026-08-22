import { camera } from './core.js';

let audioCtx;
function ac() { if (!audioCtx) audioCtx = new AudioContext(); return audioCtx; }
function noiseBuffer(ctx, dur) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
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

export function sfxEnemyShoot(pos) {
  // Quieter, distance-attenuated
  const d = camera.position.distanceTo(pos);
  playGunshot(Math.max(0.05, 0.3 - d / 150), 700, 0.1);
}

export function sfxReload() {
  playGunshot(0.12, 500, 0.06);
  setTimeout(() => playGunshot(0.12, 800, 0.06), 250);
  setTimeout(() => playGunshot(0.15, 1000, 0.08), 1100);
}

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

export function sfxHurt() {
  const ctx = ac();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(220, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.15);
  g.gain.setValueAtTime(0.15, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.15);
}
