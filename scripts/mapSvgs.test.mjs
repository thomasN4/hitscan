// scripts/mapSvgs.test.mjs — the reference-map sync gate.
//
// docs/maps/*.png are GENERATED from the map specs (scripts/mapSvg.mjs over
// src/maps/*Spec.ts plus BOT_SPAWNS/DOM_FLAGS, rasterised by
// scripts/mapPng.mjs), and the builders attach those
// same specs to the world — one source of truth, two consumers. This gate is
// what makes that claim enforceable rather than aspirational:
//
// - every BUILDERS key has a spec and a committed PNG (a new map with no
//   drawing fails here, the way a new MapName without a builder fails tsc);
// - the committed bytes equal a fresh render (a spec change with no regen
//   fails — run `npm run maps:regen`, i.e. WRITE_MAPS=1, to re-emit);
// - no transparency attribute survives anywhere in the SVG (the opaque-only
//   rule), and every rasterised pixel is fully opaque;
// - flight landings and entry counts are pinned, so a spec edit that moves a
//   stair mouth or drops a box reads as a named diff, not a silent redraw.
//
// This is a repo-hygiene check, not a simulation test: it reads specs and SVG
// files off disk and asserts nothing about game behavior. It lives in scripts/
// so src/ stays game code, and rides in `npm test` like the lesson-numbering
// and plan-relay-log gates. Builders contain no placement numbers of their own
// — every number lives in the spec — so builder/spec drift would mean deleting
// the consumption loop, which review catches; the byte-match here catches
// everything else.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { BUILDERS } from '../src/maps/index';
import { BOT_SPAWNS, DOM_FLAGS } from '../src/core/state';
import { arenaSpec } from '../src/maps/arenaSpec';
import { rangeSpec } from '../src/maps/rangeSpec';
import { elevationSpec } from '../src/maps/elevationSpec';
import { warehouse1Spec } from '../src/maps/warehouse1Spec';
import { warehouse2Spec } from '../src/maps/warehouse2Spec';
import { flightTop, renderMapSvg } from './mapSvg.mjs';
import { MAP_PNG_WIDTH, renderMapPng, renderMapRaster } from './mapPng.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS_DIR = join(ROOT, 'docs', 'maps');
const WRITE = process.env.WRITE_MAPS === '1';

// One row per map: the spec behind both the builder and the drawing.
const MAPS = [
  { name: 'arena', display: 'Arena', spec: arenaSpec, sources: 'src/maps/arenaSpec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts' },
  { name: 'range', display: 'Range', spec: rangeSpec, sources: 'src/maps/rangeSpec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts' },
  { name: 'elevation', display: 'Elevation', spec: elevationSpec, sources: 'src/maps/elevationSpec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts' },
  { name: 'warehouse1', display: 'Warehouse 1', spec: warehouse1Spec, sources: 'src/maps/warehouse1Spec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts' },
  { name: 'warehouse2', display: 'Warehouse 2', spec: warehouse2Spec, sources: 'src/maps/warehouse2Spec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts' },
];

const pngPath = (name) => join(MAPS_DIR, `${name}.png`);
const renderSvg = (row) => renderMapSvg(row.display, row.spec(), BOT_SPAWNS[row.name], DOM_FLAGS[row.name], row.sources);

// Flight landings the maps promise in their own docs: [x, topY, z] per flight,
// in spec order. The arithmetic is world.ts:stairLink's; the numbers are the
// builders' (elevation's "flush with the slab's south edge at z = 0", the
// warehouse2 lip join, ...). A landing that moves without its map's join
// moving routes bots at a point no staircase reaches.
const FLIGHT_TOPS = {
  arena: [[26, 2.4, 30]],
  range: [],
  elevation: [[4, 3.6, 0], [8, 3.6, 12.5], [35, 3.6, 6.5], [-27, 3.0, -30]],
  warehouse1: [[0, 3.6, 8], [0, 3.6, -8], [24, 1.2, 45], [-24, 1.2, 45], [24, 1.2, -45], [-24, 1.2, -45]],
  warehouse2: [[-22, 5.1, -8], [22, 5.1, 8], [32.5, 5.1, 3]],
};

// Entry counts per map: [boxes, flights, lifts, targets, labels]. A dropped
// box reads here as a number, not as a silently thinner drawing.
const ENTRY_COUNTS = {
  arena: [29, 1, 0, 0, 0],
  range: [5, 0, 0, 5, 12],
  elevation: [44, 4, 0, 0, 0],
  warehouse1: [66, 6, 0, 0, 0],
  warehouse2: [111, 3, 2, 0, 0],
};

// Transparency, in every spelling the renderer could emit by accident. `none`
// (unpainted hatch gaps, outlines) is NOT banned — over the paper rect it is
// deterministic overpaint, not alpha.
const TRANSPARENCY = /opacity|rgba\(|hsla\(|transparent/i;

// The paper rect: first painted element, covering the whole viewBox. Without
// it the drawing outside the ground rect shows the viewer's default
// (transparent), which is the alpha the opaque-only rule forbids.
const VIEWBOX = /viewBox="0 0 (\S+) (\S+)"/;
const PAPER = /^<rect x="0" y="0" width="\1" height="\2" fill="#ffffff"\/>$/m;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (WRITE) {
  mkdirSync(MAPS_DIR, { recursive: true });
  for (const row of MAPS) writeFileSync(pngPath(row.name), renderMapPng(renderSvg(row)));
}

describe('reference maps', () => {
  test('every BUILDERS map has a spec row and vice versa', () => {
    expect(MAPS.map((m) => m.name).sort()).toEqual(Object.keys(BUILDERS).sort());
  });

  test.each(MAPS)('$name spec carries the pinned entries', (row) => {
    const spec = row.spec();
    expect(spec.name).toBe(row.name);
    expect([spec.boxes.length, spec.flights.length, spec.lifts.length, spec.targets.length, spec.labels.length])
      .toEqual(ENTRY_COUNTS[row.name]);
  });

  test.each(MAPS)('$name flights land where the map promises', (row) => {
    const spec = row.spec();
    expect(spec.flights.length).toBe(FLIGHT_TOPS[row.name].length);
    spec.flights.forEach((f, i) => {
      const top = flightTop(f);
      const [x, y, z] = FLIGHT_TOPS[row.name][i];
      expect(top.x).toBeCloseTo(x, 9);
      expect(top.y).toBeCloseTo(y, 9);
      expect(top.z).toBeCloseTo(z, 9);
    });
  });

  test.each(MAPS)('$name SVG source is opaque and sourced', (row) => {
    const svg = renderSvg(row);
    // Non-vacuous: a collapsed generator must fail here, not rasterise empty.
    expect(svg.length).toBeGreaterThan(2048);
    expect(svg).not.toMatch(TRANSPARENCY);
    const box = svg.match(VIEWBOX);
    expect(box).not.toBeNull();
    expect(svg).toMatch(new RegExp(PAPER.source.replace('\\1', box[1]).replace('\\2', box[2]), 'm'));
    expect(svg).toContain('npm run maps:regen');
    expect(svg).toContain(row.sources);
  });

  test.each(MAPS)('$name committed PNG is fresh and opaque', (row) => {
    const committed = readFileSync(pngPath(row.name));
    expect(committed.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // IHDR width sits at byte 16.
    expect(committed.readUInt32BE(16)).toBe(MAP_PNG_WIDTH);
    const { png, pixels } = renderMapRaster(renderSvg(row));
    let minAlpha = 255;
    for (let i = 3; i < pixels.length; i += 4) minAlpha = Math.min(minAlpha, pixels[i]);
    expect(minAlpha).toBe(255);
    if (!WRITE) expect(committed.equals(png)).toBe(true);
  });
});
