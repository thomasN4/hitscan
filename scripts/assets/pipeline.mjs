import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = 'assets/source/arms.blend';
const output = 'public/assets/arms.glb';
const exporter = 'scripts/assets/export-arms.py';
const manifestPath = 'assets/manifest.json';
const hash = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');

export function validateGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'Truncated GLB');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binStart = 28 + jsonLength;
  assert.equal(bytes.readUInt32LE(24 + jsonLength), 0x004e4942);
  const bin = bytes.subarray(binStart);
  assert.equal(gltf.buffers.length, 1);
  assert.ok(!gltf.buffers[0].uri && gltf.buffers[0].byteLength <= bin.length, 'External/missing buffer');
  assert.ok(!gltf.images?.length && !gltf.animations?.length, 'Arms must be texture/animation-free');
  assert.ok(!gltf.extensionsRequired?.length, 'Unexpected runtime extension');
  assert.deepEqual(gltf.materials.map(m => m.name).sort(), ['glove', 'panel', 'sleeve']);
  const bones = [];
  for (const side of ['right', 'left']) {
    bones.push(side + '_upper', side + '_forearm', side + '-hand', side + '_thumb');
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) bones.push(`${side}_finger_${i}_${j}`);
  }
  const jointIndices = new Set(gltf.skins.flatMap(s => s.joints));
  for (const name of bones) {
    const matches = gltf.nodes.flatMap((n, i) => n.name === name ? [i] : []);
    assert.equal(matches.length, 1, `Missing/duplicate bone ${name}`);
    assert.ok(jointIndices.has(matches[0]), `${name} is not a skin joint`);
  }
  for (const side of ['right', 'left']) {
    for (const [name, length] of [['_forearm', .3], ['-hand', .29]]) {
      const node = gltf.nodes.find(n => n.name === side + name);
      assert.ok(Math.abs(node.translation[1] - length) < 1e-5, `Invalid limb length ${side}${name}`);
    }
  }
  function accessor(index) {
    const a = gltf.accessors[index];
    const view = gltf.bufferViews[a.bufferView];
    assert.ok(!a.sparse && view.buffer === 0);
    const components = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const width = { 5121: 1, 5123: 2, 5126: 4 }[a.componentType];
    assert.ok(components && width, 'Unsupported accessor');
    const stride = view.byteStride || components * width;
    const start = (view.byteOffset || 0) + (a.byteOffset || 0);
    assert.ok(start + (a.count - 1) * stride + components * width <= bin.length, 'Accessor out of bounds');
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: components }, (_, c) => {
      const offset = start + i * stride + c * width;
      const value = width === 4 ? bin.readFloatLE(offset) : width === 2 ? bin.readUInt16LE(offset) : bin.readUInt8(offset);
      return a.normalized ? value / (width === 2 ? 65535 : 255) : value;
    }));
  }
  let vertices = 0;
  for (const node of gltf.nodes.filter(n => n.mesh !== undefined)) {
    assert.ok(node.skin !== undefined, `Unskinned mesh ${node.name}`);
    const skin = gltf.skins[node.skin];
    for (const p of gltf.meshes[node.mesh].primitives) {
      assert.ok(gltf.materials[p.material]);
      const positions = accessor(p.attributes.POSITION);
      const weights = accessor(p.attributes.WEIGHTS_0);
      const joints = accessor(p.attributes.JOINTS_0);
      assert.equal(weights.length, positions.length); assert.equal(joints.length, positions.length);
      positions.forEach((v, i) => {
        assert.ok(v.every(Number.isFinite));
        assert.ok(Math.abs(v[0]) < .3 && v[1] >= -.001 && v[1] < .75 && Math.abs(v[2]) < .1, 'Arm dimensions must be metres in game coordinates');
        assert.ok(weights[i].every(w => Number.isFinite(w) && w >= 0 && w <= 1));
        assert.ok(Math.abs(weights[i].reduce((a, b) => a+b, 0) - 1) < 1e-4, 'Unnormalized weights');
        assert.ok(joints[i].every(j => Number.isInteger(j) && j >= 0 && j < skin.joints.length), 'Invalid joint index');
      });
      vertices += positions.length;
    }
  }
  assert.ok(vertices > 500 && vertices < 20000, 'Unexpected vertex budget');
  return { bones: bones.length, vertices, bytes: bytes.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'export') {
    const result = spawnSync(process.env.BLENDER || 'blender', ['--background', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', exporter], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ALSOFT_DRIVERS: 'null' },
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr + result.stdout);
    const stats = validateGlb(readFileSync(root + output));
    const version = result.stdout.match(/ASSET_BLENDER_VERSION=(.+)/)?.[1];
    assert.ok(version, 'Exporter did not report Blender version');
    writeFileSync(root + manifestPath, JSON.stringify({ version: 1, source, output, exporter,
      sourceSha256: hash(source), outputSha256: hash(output), exporterSha256: hash(exporter),
      blender: version, settings: { format: 'GLB', coordinates: 'metres, Y-up, forward -Z', export_yup: false, animations: false }, stats,
    }, null, 2) + '\n');
    console.log('Exported arms:', stats);
  } else if (mode === 'check') {
    const manifest = JSON.parse(readFileSync(root + manifestPath));
    assert.equal(manifest.sourceSha256, hash(source), 'Source changed: run npm run assets:export');
    assert.equal(manifest.outputSha256, hash(output), 'Output changed: run npm run assets:export');
    assert.equal(manifest.exporterSha256, hash(exporter), 'Exporter changed: run npm run assets:export');
    assert.deepEqual(validateGlb(readFileSync(root + output)), manifest.stats);
    console.log('Arms source, export and contract verified:', manifest.stats);
  } else throw new Error('Usage: pipeline.mjs export|check');
}
