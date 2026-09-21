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
import { gameTime, type BotWeaponId } from './core/state';
import type { ScheduledHandle } from './sim/gameClock';

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

/** AK-47: fuller low report, distinct from the fast SMG crack. */
export const sfxAk47 = (): void => playGunshot(0.46, 680, 0.20);

export const sfxShoot = (): void => playGunshot(0.4, 1400, 0.14);

/** Sniper: deeper boom with a longer tail than the smg crack. */
export const sfxSniper = (): void => playGunshot(0.5, 500, 0.3);

/** Shotgun: big low boom, longer tail — a powder charge, not a cartridge crack. */
export const sfxShotgun = (): void => playGunshot(0.55, 380, 0.28);

/** Short barrels give the sawn-off a sharper report than the pump. */
export const sfxSawnOff = (): void => playGunshot(0.55, 440, 0.24);

/** Pistol: sharper, shorter crack than the smg burst. */
export const sfxPistol = (): void => playGunshot(0.35, 1100, 0.09);

/** Revolver: louder, fuller bark than the pistol — more powder, longer barrel. */
export const sfxRevolver = (): void => playGunshot(0.48, 750, 0.18);

/**
 * Knife swing: an airy whoosh, not a crack — bandpassed noise sweeping down,
 * no lowpass "powder" thump underneath.
 */
export function sfxKnife(): void {
  const ctx = ac();
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.12);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(2400, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.12);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.18, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

/** Knife connect: dull, meaty thunk — the swing's payoff. */
export const sfxKnifeHit = (): void => playGunshot(0.25, 300, 0.09);

/** Weapon switch: short metallic click. */
export const sfxSwitch = (): void => playGunshot(0.1, 1800, 0.04);

/** Scope zoom step: even softer tick. */
export const sfxZoom = (): void => playGunshot(0.08, 2400, 0.03);

/**
 * A weapon's attack as heard from ELSEWHERE in the world, plus how fast it
 * fades with distance.
 *
 * Deliberately a second table rather than a shared one with the player's
 * sfx* consts above. Those are the near-field sound of a gun at your own
 * shoulder; these are the far-field sound of one across a map, and the two
 * genuinely want different volumes and tails — sharing one set of numbers
 * would make one of the two situations wrong. Both are Records over the id
 * union, so a new weapon fails to compile until it has an entry in each.
 *
 * `falloff` is PRESENTATION loudness: how far a shot carries to the PLAYER'S
 * ear. It is emphatically NOT soundEvents.ts:GUNSHOT_RADIUS_M, which is how
 * far a shot carries to a BOT's, is one number for every firearm, and is
 * deferred by docs/ai-plan.md until it has a validateWeapons rule behind it.
 * Changing one of these does not change the other, and it must not: a sniper
 * that sounds louder than a pistol is a cue, while a sniper that is HEARD
 * further than a pistol is a balance change to 6b's investigation geometry.
 * The blade has no hearing radius at all, which applies the same warning with
 * even more force — its falloff below is presentation only.
 */
interface EnemyAttackTone {
  /** Which synth realizes it: a firearm's report, or a blade's swish. */
  voice: 'report' | 'swish';
  /** Volume at zero distance, before attenuation. */
  vol: number;
  /** Metres of separation that bleed one unit of `vol`. */
  falloff: number;
  freqBase: number;
  dur: number;
}

const ENEMY_ATTACK_TONE: Record<BotWeaponId, EnemyAttackTone> = {
  ak47: { voice: 'report', vol: 0.36, falloff: 190, freqBase: 600, dur: 0.16 },
  smg:      { voice: 'report', vol: 0.30, falloff: 150, freqBase: 800, dur: 0.09 },
  pistol:   { voice: 'report', vol: 0.26, falloff: 130, freqBase: 950, dur: 0.08 },
  revolver: { voice: 'report', vol: 0.36, falloff: 190, freqBase: 640, dur: 0.16 },
  // Deepest and longest-tailed, and it carries furthest — the report is how
  // you learn there is a sniper before you find out the hard way.
  sniper:   { voice: 'report', vol: 0.40, falloff: 260, freqBase: 430, dur: 0.26 },
  sawnOff: { voice: 'report', vol: 0.42, falloff: 170, freqBase: 390, dur: 0.20 },
  shotgun:  { voice: 'report', vol: 0.42, falloff: 170, freqBase: 330, dur: 0.24 },
  // A swing you hear only if it is nearly on you: close-range and short.
  knife:    { voice: 'swish', vol: 0.22, falloff: 45, freqBase: 1400, dur: 0.12 },
};

/**
 * A short filtered noise burst: the bandpass pattern sfxFootstep already
 * uses, attenuated by camera distance the same way the report is.
 */
function playSwish(vol: number, freqBase: number, dur: number): void {
  const ctx = ac();
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(freqBase, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, freqBase / 4), ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

/** Enemy attack: attenuated with distance from the camera, timbre by weapon. */
export function sfxEnemyAttack(pos: THREE.Vector3, weapon: BotWeaponId): void {
  const tone = ENEMY_ATTACK_TONE[weapon];
  const d = camera.position.distanceTo(pos);
  const vol = Math.max(0.05, tone.vol - d / tone.falloff);
  if (tone.voice === 'swish') playSwish(vol, tone.freqBase, tone.dur);
  else playGunshot(vol, tone.freqBase, tone.dur);
}

/**
 * Three clicks approximating mag-out / mag-in / bolt. Timed to reloadTime,
 * scheduled on the GAME clock so they freeze if the reload pauses — the
 * sounds stay in sync with the animation instead of playing over a
 * suspended one.
 */
export function sfxReload(duration: number): ScheduledHandle {
  playGunshot(0.12, 500, 0.06);   // click 1: immediately
  const pending = [
    gameTime.schedule(duration * 0.25, () => playGunshot(0.12, 800, 0.06)),
    gameTime.schedule(duration * 0.77, () => playGunshot(0.15, 1000, 0.08)),
  ];
  return { cancel: () => pending.forEach(handle => handle.cancel()) };
}

/** Break open, extract, seat and lock; cancellation owns every pending cue. */
export function sfxBreakReload(duration: number): ScheduledHandle {
  sfxMechanism();
  const pending = [
    gameTime.schedule(duration * 0.28, sfxMechanism),
    gameTime.schedule(duration * 0.72, sfxShell),
    gameTime.schedule(duration * 0.94, sfxMechanism),
  ];
  return { cancel: () => pending.forEach(handle => handle.cancel()) };
}

/** Short dry clack at the pump/bolt's travel milestones; called on game ticks. */
export function sfxMechanism(): void {
  playGunshot(0.09, 620, 0.045);
}

/** One shell/chamber seating home — the per-round reload's transfer click. */
export function sfxShell(): void {
  playGunshot(0.13, 900, 0.05);
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
