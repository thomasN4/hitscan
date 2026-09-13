import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const exporter = 'scripts/assets/export-weapons.py';
const manifestPath = 'assets/weapons-manifest.json';
const hash = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
// The glTF add-on version (e.g. v5.2.39 vs v5.2.40) is embedded in every GLB's
// asset.generator, so re-exporting untouched sources still rewrote all six
// binaries (issue #112). Export strips the version tail to this canonical
// string before hashing, while the manifest records the actual add-on version
// as provenance beside blender.
export const CANONICAL_GENERATOR = 'Khronos glTF Blender I/O';
// Shared GLB JSON-chunk parse with framing validation, so the mixed-generator
// sweep and the full validator both report a named error (weapon id + fix)
// instead of a bare SyntaxError/RangeError on corrupt input. Returns the
// parsed JSON plus the chunk length for BIN offsets.
export function parseGlbJson(bytes, id) {
  const label = id ?? 'weapon';
  assert.ok(bytes.length >= 20, `Truncated weapon GLB ${label}: run assets:export`);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `Invalid weapon GLB ${label}: run assets:export`);
  assert.equal(bytes.readUInt32LE(4), 2, `Invalid weapon GLB ${label}: run assets:export`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `Truncated weapon GLB ${label}: run assets:export`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.ok(20 + jsonLength <= bytes.length, `Truncated weapon GLB ${label}: run assets:export`);
  try {
    return { gltf: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()), jsonLength };
  } catch {
    throw new Error(`Invalid weapon GLB ${label}: corrupt JSON chunk: run assets:export`);
  }
}
export function readGlbGenerator(bytes, id) {
  return parseGlbJson(bytes, id).gltf.asset?.generator;
}
// The previous-version warning is advisory: a missing manifest (first export
// from a clean checkout) or one with conflict markers (the documented way to
// regenerate it) just skips the warning instead of failing the export after
// Blender already ran. The reader is injectable so tests can pin the
// missing/broken cases without touching the real manifest.
export function readPreviousGltfAddon(readText = () => readFileSync(root + manifestPath, 'utf8')) {
  try {
    return JSON.parse(readText())?.gltfAddon;
  } catch (e) {
    if (e?.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    return undefined;
  }
}
// Replace only the generator value, leaving every other JSON byte untouched,
// then re-pad the chunk with spaces to 4-byte alignment and fix both length
// fields. The pre-existing padding is stripped first: without that, inputs
// whose version tails differ in length keep different amounts of old padding
// and never converge. Inputs differing only by exporter version then normalize
// byte-identical; anything without a Khronos generator is returned unchanged
// for the validator to reject with a named error instead.
export function normalizeWeaponGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const stripped = bytes.subarray(20, 20 + jsonLength).toString()
    .replace(/("generator"\s*:\s*")Khronos glTF Blender I\/O[^"]*(")/, `$1${CANONICAL_GENERATOR}$2`)
    .replace(/ +$/, '');
  const padded = stripped + ' '.repeat((4 - Buffer.byteLength(stripped) % 4) % 4);
  const out = Buffer.alloc(20 + Buffer.byteLength(padded) + (bytes.length - 20 - jsonLength));
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(Buffer.byteLength(padded), 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  out.write(padded, 20);
  bytes.subarray(20 + jsonLength).copy(out, 20 + Buffer.byteLength(padded));
  return out;
}
export function validateWeaponGlb(bytes, id) {
  const { gltf, jsonLength: length } = parseGlbJson(bytes, id);
  assert.equal(gltf.asset?.generator, CANONICAL_GENERATOR,
    `Unnormalized asset.generator ${gltf.asset?.generator}: run assets:export`);
  assert.ok(bytes.length >= 28 + length, `Truncated weapon GLB ${id ?? 'weapon'}: run assets:export`);
  assert.equal(bytes.readUInt32LE(24 + length), 0x004e4942);
  assert.equal(gltf.buffers.length, 1);
  assert.ok(!gltf.buffers[0].uri && gltf.buffers[0].byteLength <= bytes.length - length - 28);
  assert.ok(!gltf.images?.length && !gltf.animations?.length && !gltf.extensionsRequired?.length);
  assert.ok(['shotgun', 'revolver', 'pistol', 'smg', 'sniper', 'knife'].includes(id), 'Unknown weapon asset');
  const parts = {
    shotgun: ['grip_left', 'mechanism_pump'], revolver: ['mechanism_cylinder', 'mechanism_rotor', 'mechanism_hammer'],
    pistol: ['grip_left', 'mechanism_slide', 'mechanism_magazine', 'magazine_out'],
    smg: ['grip_left', 'mechanism_slide', 'mechanism_magazine', 'magazine_out'],
    sniper: ['grip_left', 'mechanism_bolt', 'mechanism_magazine', 'magazine_out'], knife: ['blade_tip'],
  };
  const required = ['grip_right', ...(id === 'knife' ? [] : ['reload_port', 'Muzzle']), ...parts[id]];
  for (const name of required) assert.equal(gltf.nodes.filter(n => n.name === name).length, 1, `Missing/duplicate ${name}`);
  const palettes = {
    smg: ['Brushed steel', 'Charcoal blued steel', 'Recess / rubber'],
    sniper: ['Brushed steel', 'Charcoal blued steel', 'Olive composite', 'Recess / rubber'],
    knife: ['Brushed steel', 'Charcoal blued steel', 'Recess / rubber'],
    pistol: ['Brushed steel', 'Charcoal blued steel', 'Ivory sight inserts', 'Recess / rubber', 'Satin graphite slide', 'Slate grip panels'],
    shotgun: ['Brass', 'Brushed steel', 'Charcoal blued steel', 'Recess / rubber', 'Walnut end grain', 'Warm walnut'],
    revolver: ['Brass', 'Brushed steel', 'Charcoal blued steel', 'Recess / rubber', 'Walnut end grain', 'Warm walnut'],
  };
  assert.deepEqual(gltf.materials.map(m => m.name).sort(), palettes[id]);
  assert.ok(gltf.meshes.length > 0);
  const nodeIndex = name => gltf.nodes.findIndex(n => n.name === name);
  if (id === 'shotgun' || id === 'revolver') {
    const owner = gltf.nodes[nodeIndex(id === 'shotgun' ? 'mechanism_pump' : 'mechanism_cylinder')];
    for (const name of id === 'shotgun' ? ['grip_left'] : ['mechanism_rotor', 'reload_port'])
      assert.ok(owner.children.includes(nodeIndex(name)), `Detached attachment ${name}`);
    if (id === 'revolver') {
      // The seated cartridges are the only brass under the rotor. Without them the
      // bored-through chambers read as an empty gun, so guard against a re-export
      // that drops them (they merge into one mesh, by material, under the rotor).
      const rotor = gltf.nodes[nodeIndex('mechanism_rotor')];
      const brass = gltf.materials.findIndex(m => m.name === 'Brass');
      assert.ok((rotor.children ?? []).some(child => gltf.nodes[child]?.mesh !== undefined
        && gltf.meshes[gltf.nodes[child].mesh].primitives.some(p => p.material === brass)),
        'Revolver chambers carry no cartridges');
    }
  } else {
    const roots = gltf.scenes[gltf.scene].nodes;
    for (const name of required) assert.ok(roots.includes(nodeIndex(name)), `${id} attachment must be fixed at root: ${name}`);
    if (id !== 'knife') {
      const start = gltf.nodes[nodeIndex('reload_port')].translation;
      const end = gltf.nodes[nodeIndex('magazine_out')].translation;
      assert.ok(start?.length === 3 && end?.length === 3 && [...start, ...end].every(Number.isFinite));
      const travel = end.map((value, i) => value - start[i]);
      assert.ok(Math.abs(travel[0]) < 1e-6 && travel[1] < -.13
        && (id === 'pistol' ? travel[2] > 0 : Math.abs(travel[2]) < 1e-6)
        && Math.hypot(...travel) < .3, `Invalid ${id} magazine path`);
    }
  }
  let vertices = 0;
  for (const mesh of gltf.meshes) for (const p of mesh.primitives) {
    assert.ok(gltf.materials[p.material], 'Missing material');
    const a = gltf.accessors[p.attributes.POSITION];
    assert.ok(a.count > 0 && [...a.min, ...a.max].every(Number.isFinite), 'Invalid geometry');
    assert.ok(a.max.every((v,i) => v-a.min[i] < 1.5), 'Invalid weapon dimensions');
    vertices += a.count;
  }
  return { vertices, meshes: gltf.meshes.length, bytes: bytes.length };
}
export function weaponPipeline(mode) {
  if (mode === 'export') {
    const result = spawnSync(process.env.BLENDER || 'blender', ['--background','--factory-startup','--python-exit-code','1','--python',exporter],
      {cwd:root, encoding:'utf8', env:{...process.env,ALSOFT_DRIVERS:'null'}});
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr + result.stdout);
    const blender = result.stdout.match(/ASSET_BLENDER_VERSION=(.+)/)?.[1]?.trim();
    assert.ok(blender);
    const gltfAddon = result.stdout.match(/ASSET_GLTF_ADDON_VERSION=(.+)/)?.[1]?.trim();
    assert.match(gltfAddon ?? '', /^\d+\.\d+\.\d+$/, 'Exporter did not report a glTF add-on version');
    const previous = readPreviousGltfAddon();
    if (previous && previous !== gltfAddon)
      console.warn(`glTF add-on moved ${previous} -> ${gltfAddon}; normalized output should be unaffected`);
    const assets = ['shotgun','revolver','pistol','smg','sniper','knife'].map(id => {
      const source=`assets/source/${id}.blend`, output=`public/assets/${id}.glb`;
      const normalized = normalizeWeaponGlb(readFileSync(root+output));
      writeFileSync(root+output, normalized);
      return {id,source,output,sourceSha256:hash(source),outputSha256:hashBytes(normalized),stats:validateWeaponGlb(normalized,id)};
    });
    writeFileSync(root+manifestPath,JSON.stringify({version:1,blender,gltfAddon,exporter,exporterSha256:hash(exporter),settings:{format:'GLB',export_yup:false,export_texcoords:false,animations:false,coordinates:'metres, Y-up, forward -Z'},assets},null,2)+'\n');
  } else {
    const manifest=JSON.parse(readFileSync(root+manifestPath));
    assert.equal(manifest.exporterSha256,hash(exporter),'Weapon exporter changed: run assets:export');
    assert.match(manifest.gltfAddon ?? '', /^\d+\.\d+\.\d+$/, 'Weapon manifest lacks gltfAddon: run assets:export');
    assert.deepEqual(manifest.assets.map(asset => asset.id).sort(), ['knife','pistol','revolver','shotgun','smg','sniper']);
    const entries = manifest.assets.map(asset => ({ asset, bytes: readFileSync(root + asset.output) }));
    const seen = entries.map(({ asset, bytes }) => readGlbGenerator(bytes, asset.id));
    assert.equal(new Set(seen).size, 1, `Mixed exporter versions across GLBs ${[...new Set(seen)]}: run assets:export`);
    for(const { asset, bytes } of entries) {
      assert.equal(asset.sourceSha256,hash(asset.source),'Weapon source changed: run assets:export');
      assert.equal(asset.outputSha256,hashBytes(bytes),'Weapon output changed: run assets:export');
      assert.deepEqual(validateWeaponGlb(bytes,asset.id),asset.stats);
    }
  }
  console.log(`Weapon assets ${mode} verified`);
}

// CLI entry: `npm run assets:export` / `assets:check`. This used to hang off
// the arm pipeline, which called weaponPipeline() as its last line; the arms
// are gone and this is now the only asset pipeline.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== 'export' && mode !== 'check') throw new Error('Usage: weapon-pipeline.mjs export|check');
  weaponPipeline(mode);
}
