import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CANONICAL_GENERATOR, hashBytes, normalizeWeaponGlb, readGlbGenerator, readPreviousGltfAddon } from './weapon-pipeline.mjs';
// Minimal GLB framing around a caller-supplied generator string: header, one
// JSON chunk, one empty BIN chunk. Geometry-free on purpose — these tests pin
// the generator normalization, not the weapon contract (weaponRig.test.mjs).
function syntheticGlb(generator) {
  const json = JSON.stringify({ asset: { generator, version: '2.0' } });
  const padded = json + ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4);
  const out = Buffer.alloc(28 + Buffer.byteLength(padded));
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(Buffer.byteLength(padded), 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  out.write(padded, 20);
  out.writeUInt32LE(0, 20 + Buffer.byteLength(padded));
  out.writeUInt32LE(0x004e4942, 24 + Buffer.byteLength(padded));
  return out;
}

test('add-on version bumps normalize byte-identical', () => {
  const a = normalizeWeaponGlb(syntheticGlb('Khronos glTF Blender I/O v5.2.39'));
  const b = normalizeWeaponGlb(syntheticGlb('Khronos glTF Blender I/O v5.2.40'));
  expect(readGlbGenerator(a)).toBe(CANONICAL_GENERATOR);
  expect(a.equals(b)).toBe(true);
  expect(a.readUInt32LE(8)).toBe(a.length);
  expect(a.readUInt32LE(24 + a.readUInt32LE(12))).toBe(0x004e4942);
  expect(normalizeWeaponGlb(a).equals(a)).toBe(true);
});

test('different-length version tails still converge', () => {
  const a = normalizeWeaponGlb(syntheticGlb('Khronos glTF Blender I/O v5.2.9'));
  const b = normalizeWeaponGlb(syntheticGlb('Khronos glTF Blender I/O v5.2.40'));
  expect(a.equals(b)).toBe(true);
});

test('non-Khronos generator is left for the validator to reject', () => {
  const input = syntheticGlb('Some Other Exporter 1.0');
  expect(normalizeWeaponGlb(input).equals(input)).toBe(true);
});

test('corrupt GLBs report a named weapon error, not a bare parse failure', () => {
  const ok = syntheticGlb(CANONICAL_GENERATOR);
  expect(readGlbGenerator(ok, 'knife')).toBe(CANONICAL_GENERATOR);
  // Too short to hold a header: RangeError without the framing guard.
  expect(() => readGlbGenerator(Buffer.alloc(10), 'knife')).toThrow(/Truncated weapon GLB knife/);
  // Truncated tail: total-length mismatch, as in weaponRig's subarray case.
  expect(() => readGlbGenerator(ok.subarray(0, ok.length - 8), 'knife')).toThrow(/Truncated weapon GLB knife/);
  // Declared JSON length overrunning the buffer: subarray would clamp and
  // JSON.parse would throw a bare SyntaxError without the bounds check.
  const overrun = Buffer.from(ok);
  overrun.writeUInt32LE(0xffffff, 12);
  expect(() => readGlbGenerator(overrun, 'knife')).toThrow(/Truncated weapon GLB knife/);
  // Bytes in bounds but not JSON: still named, with the weapon and the fix.
  const corrupt = Buffer.from(ok);
  corrupt[20] = 0xff;
  expect(() => readGlbGenerator(corrupt, 'knife')).toThrow(/Invalid weapon GLB knife/);
});

test('missing or conflicted manifest just skips the previous-version warning', () => {
  const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  expect(readPreviousGltfAddon(enoent)).toBeUndefined();
  expect(readPreviousGltfAddon(() => '<<<<<<< HEAD\n{"gltfAddon":"5.2.39"}\n=======\n>>>>>>>')).toBeUndefined();
  expect(readPreviousGltfAddon(() => JSON.stringify({ gltfAddon: '5.2.40' }))).toBe('5.2.40');
  expect(readPreviousGltfAddon()).toMatch(/^\d+\.\d+\.\d+$/);
});

test('buffer hashing matches the recorded output hashes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../assets/weapons-manifest.json', import.meta.url)));
  for (const asset of manifest.assets) {
    const bytes = readFileSync(new URL(`../../${asset.output}`, import.meta.url));
    expect(hashBytes(bytes)).toBe(asset.outputSha256);
  }
});

for (const id of ['shotgun', 'revolver', 'pistol', 'smg', 'sniper', 'knife', 'ak47']) {
  test(`${id} committed GLB carries the canonical generator`, () => {
    const bytes = readFileSync(new URL(`../../public/assets/${id}.glb`, import.meta.url));
    expect(readGlbGenerator(bytes)).toBe(CANONICAL_GENERATOR);
  });
}
