// scripts/mapSvg.mjs — top-down reference maps, rendered from the map specs.
//
// Pure string building, zero dependencies: (displayName, spec, spawns|null, flags)
// in, one SVG document out. The SVG is never committed: mapPng.mjs rasterises
// it to docs/maps/*.png, and those files are this pipeline's output
// byte-for-byte — regenerate with `npm run maps:regen`, never by hand
// (scripts/mapSvgs.test.mjs fails while a file is stale).
//
// The whole file honours one visual rule: NO alpha blending anywhere. No
// `opacity`/`fill-opacity`/`stroke-opacity` attributes, no rgba()/hsla(), no
// transparent paint — every pixel's colour is decided by overpaint order, so
// the drawings print and photocopy exactly as they read on screen. A white
// paper rect covers the whole viewBox first, so nothing is unpainted even
// outside the ground rect. Upper levels (decks, slabs, bridges) are HATCHED
// but fully opaque: the hatch
// pattern tile carries its own solid background, and whatever stands beneath
// a deck (ground-floor walls) is drawn OVER the deck fill in paint order —
// never seen through a gap. Unpainted shape interiors (`fill="none"` outlines
// for stairs, roofs, targets) always sit over an opaque layer below.
// Resolved only against the vendored files in scripts/assets/fonts (mapPng.mjs).
const FONT = 'Noto Sans';

// Opaque palette. Halo is the light label backing (solid paint-order stroke).
const C = {
  text: '#222222',
  muted: '#555555',
  halo: '#f2ecdc',
  ground: '#d9c69c',
  groundStroke: '#8a7a55',
  gridMinor: '#cbbb90',
  gridMajor: '#b3a179',
  axis: '#8a7a55',
  wall: '#b89b62',
  wall2: '#a1804e',
  masonryStroke: '#5d4a26',
  crate: '#8a6d3f',
  crateStroke: '#4a3517',
  crateHighDash: '#241a0c',
  rack: '#3f6a8c',
  rackStroke: '#22394b',
  rail: '#4f4227',
  conveyor: '#b3b8bf',
  conveyorStroke: '#5f646b',
  fence: '#9aa1a9',
  fenceStroke: '#565c63',
  deckFill: '#cfccc0',
  deckHatch: '#767676',
  deckOutline: '#444444',
  roofOutline: '#6e7680',
  stairOutline: '#7d5a29',
  stairArrow: '#7d3c00',
  marker: '#3a3226',
  paper: '#ffffff',
  target: '#6b5320',
  lift: '#e08b28',
  liftStroke: '#7a4a12',
  spawnT: '#eed3cd',
  spawnTStroke: '#922b21',
  spawnCT: '#d2e4f2',
  spawnCTStroke: '#1a5276',
  flagInk: ['#935116', '#6c3483', '#1a5276', '#1e8449', '#7b241c'],
};

/** XML-escape text content and attribute values (notes carry `->` and `<->`). */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// No literal comment markers appear in this file's source below: Vite's
// import-analysis scanner reads them as HTML even inside a string, so they
// are built by concatenation.
const COM_OPEN = '<!' + '--';
const COM_CLOSE = '--' + '>';

/** Compact number: 2 decimals max, no trailing zeros (keeps diffs readable). */
function fmt(n) {
  return String(Math.round(n * 100) / 100);
}

/**
 * Footprint of one stair flight in world x/z: the rect its steps cover.
 * (x, z) is the first step's centre, half a tread along `dir` from the mouth;
 * the far edge of the last step sits `count` treads along.
 */
function flightRect(f) {
  const run = f.count * f.stepD;
  const x0 = f.dir === 'x+' ? f.x : f.dir === 'x-' ? f.x - run : f.x - f.width / 2;
  const x1 = f.dir === 'x+' ? f.x + run : f.dir === 'x-' ? f.x : f.x + f.width / 2;
  const z0 = f.dir === 'z+' ? f.z : f.dir === 'z-' ? f.z - run : f.z - f.width / 2;
  const z1 = f.dir === 'z+' ? f.z + run : f.dir === 'z-' ? f.z : f.z + f.width / 2;
  return { x0, x1, z0, z1 };
}

/** Top landing of one flight: the point navigation aims at (world.ts:stairLink). */
export function flightTop(f) {
  const run = f.count * f.stepD;
  return {
    x: f.dir === 'x+' ? f.x + run : f.dir === 'x-' ? f.x - run : f.x,
    y: f.y + f.count * f.stepH,
    z: f.dir === 'z+' ? f.z + run : f.dir === 'z-' ? f.z - run : f.z,
  };
}

/** Kinds drawn as solid ground-level masses, and their fills. */
const MASS_FILL = {
  wall: C.wall,
  wall2: C.wall2,
  crate: C.crate,
  rack: C.rack,
  rail: C.rail,
  stair: C.rail,
  conveyor: C.conveyor,
  fence: C.fence,
  post: C.fenceStroke,
  marker: C.marker,
  pad: C.lift,
};

/** Outline colours for the solid masses. */
const MASS_STROKE = {
  wall: C.masonryStroke,
  wall2: C.masonryStroke,
  crate: C.crateStroke,
  rack: C.rackStroke,
  rail: C.rail,
  stair: C.rail,
  conveyor: C.conveyorStroke,
  fence: C.fenceStroke,
  post: C.fenceStroke,
  marker: C.marker,
  pad: C.liftStroke,
};

/**
 * Render one reference map.
 *
 * @param displayName pretty title ("Elevation")
 * @param spec MapSpec from the map's *Spec.ts module
 * @param spawns BOT_SPAWNS entry for the map ({ T, CT } SpawnZones), or null
 *   for a map with no bots (the range): no pockets are drawn or legended
 * @param flags DOM_FLAGS entry for the map (FlagDef[], possibly empty)
 * @param sources short source line for the header comment, e.g.
 *   "src/maps/elevationSpec.ts + BOT_SPAWNS/DOM_FLAGS in src/core/state.ts"
 */
export function renderMapSvg(displayName, spec, spawns, flags, sources) {
  const g = spec.ground;
  const gW = g.maxX - g.minX;
  const gH = g.maxZ - g.minZ;
  const margin = Math.max(gW, gH) * 0.06;

  // Fit the ground (plus margin) into ~880 px; cap the height so a tall map
  // stays on one screen. A map that ends up narrow (the 30 x 130 lane) would
  // strand most of the width, so it moves the legend into a right-hand column
  // and takes a taller cap instead — the lane is drawn wider, not the page.
  let scale = 880 / (gW + margin * 2);
  if (gH * scale > 860) scale = 860 / (gH + margin * 2);
  const sideLegend = (gW + margin * 2) * scale <= 480;
  if (sideLegend) scale = Math.min(880 / (gW + margin * 2), 1100 / (gH + margin * 2));
  const mapW = (gW + margin * 2) * scale;
  const mapH = (gH + margin * 2) * scale;
  const originX = 40 + margin * scale;
  const originY = 108 + margin * scale;

  // World (meters, +x east, +z south) to drawing pixels (north = -z = up).
  const X = (x) => originX + (x - g.minX) * scale;
  const Y = (z) => originY + (z - g.minZ) * scale;

  const kinds = new Set(spec.boxes.map((b) => b.kind));
  const parts = [];
  const text = (x, y, s, attrs) => `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${esc(s)}</text>`;

  // ---- grid (world units, solid light strokes — no alpha) ----
  const grid = [];
  const stepMin = 5;
  const startX = Math.ceil(g.minX / stepMin) * stepMin;
  const startZ = Math.ceil(g.minZ / stepMin) * stepMin;
  const minor = [];
  const major = [];
  for (let x = startX; x <= g.maxX + 1e-9; x += stepMin) {
    (Math.round(x) % 10 === 0 ? major : minor).push(`M${fmt(X(x))} ${fmt(Y(g.minZ))}V${fmt(Y(g.maxZ))}`);
  }
  for (let z = startZ; z <= g.maxZ + 1e-9; z += stepMin) {
    (Math.round(z) % 10 === 0 ? major : minor).push(`M${fmt(X(g.minX))} ${fmt(Y(z))}H${fmt(X(g.maxX))}`);
  }
  grid.push(`<path d="${minor.join(' ')}" stroke="${C.gridMinor}" stroke-width="1"/>`);
  grid.push(`<path d="${major.join(' ')}" stroke="${C.gridMajor}" stroke-width="1.4"/>`);
  grid.push(
    `<path d="M${fmt(X(0))} ${fmt(Y(g.minZ))}V${fmt(Y(g.maxZ))} M${fmt(X(g.minX))} ${fmt(Y(0))}H${fmt(X(g.maxX))}" ` +
    `stroke="${C.axis}" stroke-width="1.2" stroke-dasharray="7 5"/>`,
  );

  // ---- spawn pockets: rects paint over decks (a zone is an annotation, and
  // the T zone on warehouse2's ring would otherwise vanish under the opaque
  // deck fill), but under walls and crates — geometry always wins. Labels are
  // collected separately and drawn late, so no wall clips a zone's name. ----
  const pocketRects = [];
  const pocketLabels = [];
  const pocketDefs = spawns ? [
    { zone: spawns.T, fill: C.spawnT, stroke: C.spawnTStroke, tag: 'T pocket' },
    { zone: spawns.CT, fill: C.spawnCT, stroke: C.spawnCTStroke, tag: 'CT pocket' },
  ] : [];
  for (const p of pocketDefs) {
    const z = p.zone;
    pocketRects.push(
      `<rect x="${fmt(X(z.minX))}" y="${fmt(Y(z.minZ))}" width="${fmt((z.maxX - z.minX) * scale)}" ` +
      `height="${fmt((z.maxZ - z.minZ) * scale)}" fill="${p.fill}" stroke="${p.stroke}" ` +
      `stroke-width="1.6" stroke-dasharray="8 5"/>`,
    );
    pocketLabels.push(text(
      X((z.minX + z.maxX) / 2), Y(z.minZ) - 8, `${p.tag} · x ${z.minX}…${z.maxX}, z ${z.minZ}…${z.maxZ}`,
      `text-anchor="middle" font-size="13" font-weight="700" fill="${p.stroke}" ` +
      `paint-order="stroke" stroke="${C.halo}" stroke-width="4"`,
    ));
  }

  // ---- boxes (decks first: ground walls paint OVER the opaque deck fill) ----
  const masses = [];
  const decks = [];
  const roofBoxes = [];
  const placedHeights = [];
  for (const b of spec.boxes) {
    const x = X(b.x - b.w / 2);
    const y = Y(b.z - b.d / 2);
    const w = b.w * scale;
    const h = b.d * scale;
    if (b.kind === 'beam') continue; // roof structure: the roofline stands for it (see legend)
    if (b.kind === 'deck') {
      const top = b.y + b.h;
      decks.push(
        `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
        `fill="url(#hatchW)" stroke="${C.deckOutline}" stroke-width="1.6" stroke-dasharray="7 4"/>`,
      );
      // One height label per deck cluster: slab pieces around one another
      // would otherwise pile the same number four deep (elevation's four
      // second-floor pieces around flag B).
      if (b.w * b.d >= 12 && !placedHeights.some((p) => Math.abs(p.y - top) < 1e-9 && Math.hypot(p.x - b.x, p.z - b.z) < 7)) {
        placedHeights.push({ x: b.x, z: b.z, y: top });
        decks.push(text(
          X(b.x), Y(b.z) + 5, fmt(top),
          `text-anchor="middle" font-size="13" font-weight="700" fill="${C.deckOutline}" ` +
          `paint-order="stroke" stroke="${C.halo}" stroke-width="4"`,
        ));
      }
      continue;
    }
    if (b.kind === 'roof' || b.kind === 'glass') {
      roofBoxes.push(b);
      continue;
    }
    const elevated = b.y > 0.05 && b.kind !== 'marker';
    const dash = elevated ? ' stroke-dasharray="6 3"' : '';
    const stroke = elevated && (b.kind === 'crate') ? C.crateHighDash : MASS_STROKE[b.kind];
    masses.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="${MASS_FILL[b.kind]}" stroke="${stroke}" stroke-width="1.2"${dash}/>`,
    );
  }

  // ---- roofline: one dashed bounding outline for all roof/glass slabs, not
  // one rect per band — five overlapping dashes would stripe the whole plan.
  const roofs = [];
  if (roofBoxes.length > 0) {
    const rx0 = Math.min(...roofBoxes.map((b) => b.x - b.w / 2));
    const rx1 = Math.max(...roofBoxes.map((b) => b.x + b.w / 2));
    const rz0 = Math.min(...roofBoxes.map((b) => b.z - b.d / 2));
    const rz1 = Math.max(...roofBoxes.map((b) => b.z + b.d / 2));
    roofs.push(
      `<rect x="${fmt(X(rx0))}" y="${fmt(Y(rz0))}" width="${fmt((rx1 - rx0) * scale)}" ` +
      `height="${fmt((rz1 - rz0) * scale)}" fill="none" stroke="${C.roofOutline}" ` +
      `stroke-width="1.4" stroke-dasharray="10 6"/>`,
    );
  }

  // ---- flights (footprint + tread ticks + uphill arrow) ----
  const stairs = [];
  for (const f of spec.flights) {
    const r = flightRect(f);
    const x = X(r.x0);
    const y = Y(r.z0);
    const w = (r.x1 - r.x0) * scale;
    const h = (r.z1 - r.z0) * scale;
    const dash = f.open ? ' stroke-dasharray="7 4"' : '';
    stairs.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="none" stroke="${C.stairOutline}" stroke-width="1.8"${dash}/>`,
    );
    // Tread ticks, one per step.
    const ticks = [];
    for (let i = 1; i < f.count; i++) {
      const t = (i + 0.5) * f.stepD;
      if (f.dir === 'z+' || f.dir === 'z-') {
        const zz = f.dir === 'z+' ? f.z + t : f.z - t;
        ticks.push(`M${fmt(X(f.x - f.width / 2))} ${fmt(Y(zz))}H${fmt(X(f.x + f.width / 2))}`);
      } else {
        const xx = f.dir === 'x+' ? f.x + t : f.x - t;
        ticks.push(`M${fmt(X(xx))} ${fmt(Y(f.z - f.width / 2))}V${fmt(Y(f.z + f.width / 2))}`);
      }
    }
    if (ticks.length > 0) {
      stairs.push(`<path d="${ticks.join(' ')}" stroke="${C.stairOutline}" stroke-width="0.8"/>`);
    }
    // Uphill arrow, mouth to landing.
    const top = flightTop(f);
    const ax0 = X(f.x);
    const ay0 = Y(f.z);
    const ax1 = X(top.x);
    const ay1 = Y(top.z);
    const dx = ax1 - ax0;
    const dy = ay1 - ay0;
    const len = Math.hypot(dx, dy) || 1;
    const hx = (dx / len) * 9;
    const hy = (dy / len) * 9;
    const nx = (-dy / len) * 4.5;
    const ny = (dx / len) * 4.5;
    stairs.push(
      `<line x1="${fmt(ax0)}" y1="${fmt(ay0)}" x2="${fmt(ax1)}" y2="${fmt(ay1)}" ` +
      `stroke="${C.stairArrow}" stroke-width="2.4"/>`,
    );
    stairs.push(
      `<polygon points="${fmt(ax1)},${fmt(ay1)} ${fmt(ax1 - hx + nx)},${fmt(ay1 - hy + ny)} ` +
      `${fmt(ax1 - hx - nx)},${fmt(ay1 - hy - ny)}" fill="${C.stairArrow}"/>`,
    );
  }

  // ---- lifts (pad + dashed ride to the upper landing) ----
  const lifts = [];
  for (const l of spec.lifts) {
    const x = X(l.x - l.width / 2);
    const y = Y(l.z - l.depth / 2);
    lifts.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(l.width * scale)}" height="${fmt(l.depth * scale)}" ` +
      `fill="${C.lift}" stroke="${C.liftStroke}" stroke-width="1.6"/>`,
    );
    const [ux, , uz] = l.upperLanding;
    lifts.push(
      `<line x1="${fmt(X(l.x))}" y1="${fmt(Y(l.z))}" x2="${fmt(X(ux))}" y2="${fmt(Y(uz))}" ` +
      `stroke="${C.liftStroke}" stroke-width="1.4" stroke-dasharray="6 4"/>`,
    );
    lifts.push(
      `<rect x="${fmt(X(ux) - 5)}" y="${fmt(Y(uz) - 5)}" width="10" height="10" ` +
      `fill="none" stroke="${C.liftStroke}" stroke-width="1.6"/>`,
    );
    lifts.push(text(
      X(l.x), Y(l.z) + 4.5, l.id,
      `text-anchor="middle" font-size="11" font-weight="700" fill="${C.liftStroke}" ` +
      `paint-order="stroke" stroke="${C.halo}" stroke-width="3.5"`,
    ));
  }

  // ---- targets ----
  const targets = [];
  for (const t of spec.targets) {
    const s = 0.55 * scale;
    targets.push(
      `<rect x="${fmt(X(t.x) - s / 2)}" y="${fmt(Y(t.z) - s / 2)}" width="${fmt(s)}" height="${fmt(s)}" ` +
      `fill="none" stroke="${C.target}" stroke-width="1.8"/>`,
    );
    targets.push(`<circle cx="${fmt(X(t.x))}" cy="${fmt(Y(t.z))}" r="2.4" fill="${C.target}"/>`);
    if (t.height > 0) {
      targets.push(text(
        X(t.x) + s / 2 + 4, Y(t.z) + 4, `+${fmt(t.height)}`,
        `font-size="11" fill="${C.target}" paint-order="stroke" stroke="${C.halo}" stroke-width="3"`,
      ));
    }
  }

  // ---- spec labels (range distance markers) ----
  const labels = [];
  for (const l of spec.labels) {
    // Text hangs just below its world point: range targets stand on their
    // own distance labels, and a centred label would hide the target mark.
    labels.push(text(
      X(l.x), Y(l.z) + 19, l.text,
      `text-anchor="middle" font-size="11" fill="${C.text}" ` +
      `paint-order="stroke" stroke="${C.halo}" stroke-width="3"`,
    ));
  }

  // ---- domination flags (capture radius to scale, solid white) ----
  const flagMarks = [];
  flags.forEach((fl, i) => {
    const ink = C.flagInk[i % C.flagInk.length];
    flagMarks.push(
      `<circle cx="${fmt(X(fl.x))}" cy="${fmt(Y(fl.z))}" r="${fmt(fl.radius * scale)}" ` +
      `fill="#ffffff" stroke="${ink}" stroke-width="2.2"/>`,
    );
    flagMarks.push(text(
      X(fl.x), Y(fl.z) + 8, fl.id,
      `text-anchor="middle" font-size="24" font-weight="800" fill="${ink}"`,
    ));
    flagMarks.push(text(
      X(fl.x), Y(fl.z) + 24, `y ${fmt(fl.feetY)}`,
      `text-anchor="middle" font-size="11" fill="${ink}"`,
    ));
  });

  // ---- scale bar (10 m, world-true) ----
  const barY = originY + gH * scale + 26;
  const scaleBar = [
    `<rect x="${fmt(X(g.minX))}" y="${fmt(barY)}" width="${fmt(10 * scale)}" height="6" fill="${C.text}"/>`,
    text(X(g.minX) + 5 * scale, barY + 22, '10 m', `text-anchor="middle" font-size="12" fill="${C.text}"`),
  ];

  // ---- legend ----
  const items = [];
  const swatch = (inner) => `<svg x="0" y="-13" width="20" height="15">${inner}</svg>`;
  const row = (sample, label) => ({ sample, label });
  if (kinds.has('wall') || kinds.has('wall2')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.wall}" stroke="${C.masonryStroke}"/>`),
      'masonry (walls, buildings, towers, platforms)',
    ));
  }
  if (kinds.has('deck')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="url(#hatchS)" stroke="${C.deckOutline}" stroke-dasharray="3 2"/>`),
      'raised deck / slab (hatched; number = top height; walls drawn over)',
    ));
  }
  if (spec.flights.length > 0) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="none" stroke="${C.stairOutline}" stroke-width="1.6"/>` +
        `<polygon points="14,6.5 8,3.5 8,9.5" fill="${C.stairArrow}"/>`),
      `stairs (arrow = uphill${spec.flights.some((f) => f.open) ? '; dashed = open steel' : ''})`,
    ));
  }
  if (kinds.has('crate')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.crate}" stroke="${C.crateStroke}"/>`),
      'crate 3×3 (dashed outline = stacked 2nd tier)',
    ));
  }
  if (kinds.has('rack')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.rack}" stroke="${C.rackStroke}"/>`),
      'racking / shelving',
    ));
  }
  if (kinds.has('rail')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.rail}"/>`),
      'parapet / void rail',
    ));
  }
  if (kinds.has('conveyor')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.conveyor}" stroke="${C.conveyorStroke}"/>`),
      'conveyor (player-vaulted; bots walk around)',
    ));
  }
  if (kinds.has('fence') || kinds.has('post')) {
    items.push(row(
      swatch(`<rect x="0" y="4" width="18" height="4" fill="${C.fence}" stroke="${C.fenceStroke}"/>`),
      'chain-link fence (blocks bodies, not bullets)',
    ));
  }
  if (kinds.has('roof') || kinds.has('glass')) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="none" stroke="${C.roofOutline}" stroke-dasharray="3 2"/>`),
      'roofline at 10 m (interior drawn; purlins omitted)',
    ));
  }
  if (kinds.has('marker')) {
    items.push(row(
      swatch(`<rect x="0" y="5" width="18" height="3" fill="${C.marker}"/>`),
      'painted floor marker (no collision)',
    ));
  }
  if (spawns) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.spawnT}" stroke="${C.spawnTStroke}" stroke-dasharray="3 2"/>`),
      'T spawn pocket',
    ));
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.spawnCT}" stroke="${C.spawnCTStroke}" stroke-dasharray="3 2"/>`),
      'CT spawn pocket',
    ));
  }
  if (flags.length > 0) {
    items.push(row(
      swatch(`<circle cx="9" cy="6.5" r="6" fill="#ffffff" stroke="${C.flagInk[1 % C.flagInk.length]}" stroke-width="1.6"/>`),
      `dom flag to scale, r ${flags.map((f) => fmt(f.radius)).join('/')} m (letter + walk-surface height)`,
    ));
  }
  if (spec.targets.length > 0) {
    items.push(row(
      swatch(`<rect x="5" y="1.5" width="8" height="8" fill="none" stroke="${C.target}" stroke-width="1.6"/>`),
      'range target (+raised height)',
    ));
  }
  if (spec.lifts.length > 0) {
    items.push(row(
      swatch(`<rect x="0" y="0" width="18" height="13" fill="${C.lift}" stroke="${C.liftStroke}"/>`),
      'cargo lift pad (dashed ride to the ring landing)',
    ));
  }

  // Single column: long labels run into a second column. Below the map, or
  // beside it (top-aligned with the drawing) when the map is narrow.
  const legendX = sideLegend ? 40 + mapW + 40 : 70;
  const legendY = sideLegend ? originY + 24 : originY + mapH + 60;
  const legendRows = items.map((it, i) => {
    const rowY = legendY + 24 + i * 24;
    return `<g transform="translate(${fmt(legendX)} ${fmt(rowY)})"><g>${it.sample}</g>` +
      `<text x="28" y="0" font-size="13" fill="${C.text}">${esc(it.label)}</text></g>`;
  });
  const notesY = legendY + 24 + items.length * 24 + 14;
  const legendH = 24 + items.length * 24 + 14 + spec.notes.length * 19 + 44;

  const noteLines = spec.notes.map((n, i) => text(
    legendX, notesY + i * 19, n,
    `font-size="12" fill="${C.muted}"`,
  ));

  // Where (0, 0) sits: the range lane runs from its firing line, not around it.
  const centred = Math.abs(g.minX + g.maxX) < 1e-9 && Math.abs(g.minZ + g.maxZ) < 1e-9;
  const originNote = centred ? 'origin at map centre' : 'origin where the dashed axes cross';

  const totalH = sideLegend
    ? Math.max(barY + 50, notesY + spec.notes.length * 19) + 44
    : legendY + legendH;
  parts.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `${COM_OPEN} ${displayName} — top-down reference, north up. Sources: ${sources}. ` +
    'Generated by scripts/mapSvg.mjs — do not edit by hand, run npm run maps:regen. ' +
    `Units are meters. ${originNote[0].toUpperCase()}${originNote.slice(1)}. +x east, +z south, north = -z (up). ` +
    `Stair arrows point UPHILL. No alpha anywhere: upper levels are opaque hatched slabs. ${COM_CLOSE}`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${fmt(totalH)}" font-family="${FONT}">`,
    `<title>${esc(displayName)} — top-down map</title>`,
    // Opaque paper behind the whole viewBox: outside the ground rect the SVG
    // would otherwise show the viewer's default (transparent).
    `<rect x="0" y="0" width="960" height="${fmt(totalH)}" fill="${C.paper}"/>`,
    '<defs>',
    `<pattern id="hatchW" width="1.1" height="1.1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="1.1" height="1.1" fill="${C.deckFill}"/>` +
    `<line x1="0" y1="0" x2="0" y2="1.1" stroke="${C.deckHatch}" stroke-width="0.16"/></pattern>`,
    `<pattern id="hatchS" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="7" height="7" fill="${C.deckFill}"/>` +
    `<line x1="0" y1="0" x2="0" y2="7" stroke="${C.deckHatch}" stroke-width="1"/></pattern>`,
    '</defs>',
    text(480, 36, `${displayName} — top-down (north up)`,
      `text-anchor="middle" font-size="22" font-weight="700" fill="${C.text}"`),
    text(480, 58, `meters · ${originNote} · +x east · +z south · north = -z (up)`,
      `text-anchor="middle" font-size="12" fill="${C.muted}"`),
    // North arrow (screen space, top right).
    '<g transform="translate(922 150)">',
    `<polygon points="0,-30 11,8 0,1 -11,8" fill="${C.text}"/>`,
    text(0, 28, 'N', `text-anchor="middle" font-size="17" font-weight="800" fill="${C.text}"`),
    text(0, 43, '-z', `text-anchor="middle" font-size="10" fill="${C.muted}"`),
    '</g>',
    // World.
    `<rect x="${fmt(X(g.minX))}" y="${fmt(Y(g.minZ))}" width="${fmt(gW * scale)}" height="${fmt(gH * scale)}" ` +
    `fill="${C.ground}" stroke="${C.groundStroke}" stroke-width="1.5"/>`,
    ...grid,
    ...decks,
    ...pocketRects,
    ...masses,
    ...roofs,
    ...stairs,
    ...lifts,
    ...targets,
    ...labels,
    ...pocketLabels,
    ...flagMarks,
    ...scaleBar,
    `<text x="${fmt(legendX)}" y="${fmt(legendY - 14)}" font-size="15" font-weight="700" fill="${C.text}">Legend</text>`,
    ...legendRows,
    ...noteLines,
    text(70, totalH - 12, `Source: ${sources} · generated — do not edit by hand.`,
      `font-size="12" fill="${C.muted}"`),
    '</svg>',
  );

  return parts.join('\n') + '\n';
}
