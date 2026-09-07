import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateGlb } from './pipeline.mjs';

const bytes = readFileSync(new URL('../../public/assets/arms.glb', import.meta.url));
test('committed arm asset and source hashes match', () => {
  expect(() => execFileSync(process.execPath, ['scripts/assets/pipeline.mjs', 'check'])).not.toThrow();
});
test('rejects truncated GLB data', () => {
  expect(() => validateGlb(bytes.subarray(0, bytes.length - 4))).toThrow('Truncated');
});
test('rejects an incompatible skeleton', () => {
  const broken = Buffer.from(bytes);
  const at = broken.indexOf(Buffer.from('left_upper'));
  expect(at).toBeGreaterThan(0);
  broken.write('lost_upper', at);
  expect(() => validateGlb(broken)).toThrow('Missing/duplicate bone');
});
