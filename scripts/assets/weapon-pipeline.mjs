import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const exporter = 'scripts/assets/export-weapons.py';
const manifestPath = 'assets/weapons-manifest.json';
const hash = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');
export function validateWeaponGlb(bytes, id) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'Invalid weapon GLB');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'Truncated weapon GLB');
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString());
  assert.equal(bytes.readUInt32LE(24 + length), 0x004e4942);
  assert.equal(gltf.buffers.length, 1);
  assert.ok(!gltf.buffers[0].uri && gltf.buffers[0].byteLength <= bytes.length - length - 28);
  assert.ok(!gltf.images?.length && !gltf.animations?.length && !gltf.extensionsRequired?.length);
  assert.ok(['shotgun', 'revolver', 'pistol'].includes(id), 'Unknown weapon asset');
  const required = ['grip_right', 'reload_port', 'Muzzle', ...(id === 'shotgun' ? ['grip_left', 'mechanism_pump'] : id === 'pistol' ? ['grip_left', 'mechanism_slide', 'mechanism_magazine', 'magazine_out'] : ['mechanism_cylinder', 'mechanism_rotor', 'mechanism_hammer'])];
  for (const name of required) assert.equal(gltf.nodes.filter(n => n.name === name).length, 1, `Missing/duplicate ${name}`);
  assert.deepEqual(gltf.materials.map(m => m.name).sort(), (id === 'pistol' ? ['Brushed steel', 'Charcoal blued steel', 'Ivory sight inserts', 'Recess / rubber', 'Satin graphite slide', 'Slate grip panels'] : ['Brass', 'Brushed steel', 'Charcoal blued steel', 'Recess / rubber', 'Walnut end grain', 'Warm walnut']));
  assert.ok(gltf.meshes.length > 0);
  const nodeIndex = name => gltf.nodes.findIndex(n => n.name === name);
  const owner = gltf.nodes[nodeIndex(id === 'shotgun' ? 'mechanism_pump' : id === 'pistol' ? 'mechanism_magazine' : 'mechanism_cylinder')];
  for (const name of id === 'shotgun' ? ['grip_left'] : id === 'pistol' ? [] : ['mechanism_rotor', 'reload_port'])
    assert.ok(owner.children.includes(nodeIndex(name)), `Detached attachment ${name}`);
  if (id === 'pistol') {
    const roots = gltf.scenes[gltf.scene].nodes;
    for (const name of required) assert.ok(roots.includes(nodeIndex(name)), `Pistol attachment must be fixed at root: ${name}`);
    const start = gltf.nodes[nodeIndex('reload_port')].translation;
    const end = gltf.nodes[nodeIndex('magazine_out')].translation;
    assert.ok(start?.length === 3 && end?.length === 3 && [...start, ...end].every(Number.isFinite));
    const travel = end.map((value, i) => value - start[i]);
    assert.ok(Math.abs(travel[0]) < 1e-6 && travel[1] < -.13 && travel[2] > 0 && Math.hypot(...travel) < .3, 'Invalid pistol magazine path');
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
    const blender = result.stdout.match(/ASSET_BLENDER_VERSION=(.+)/)?.[1];
    assert.ok(blender);
    const assets = ['shotgun','revolver','pistol'].map(id => {
      const source=`assets/source/${id}.blend`, output=`public/assets/${id}.glb`;
      return {id,source,output,sourceSha256:hash(source),outputSha256:hash(output),stats:validateWeaponGlb(readFileSync(root+output),id)};
    });
    writeFileSync(root+manifestPath,JSON.stringify({version:1,blender,exporter,exporterSha256:hash(exporter),settings:{format:'GLB',export_yup:false,export_texcoords:false,animations:false,coordinates:'metres, Y-up, forward -Z'},assets},null,2)+'\n');
  } else {
    const manifest=JSON.parse(readFileSync(root+manifestPath));
    assert.equal(manifest.exporterSha256,hash(exporter),'Weapon exporter changed: run assets:export');
    for(const asset of manifest.assets) {
      assert.equal(asset.sourceSha256,hash(asset.source),'Weapon source changed: run assets:export');
      assert.equal(asset.outputSha256,hash(asset.output),'Weapon output changed: run assets:export');
      assert.deepEqual(validateWeaponGlb(readFileSync(root+asset.output),asset.id),asset.stats);
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
