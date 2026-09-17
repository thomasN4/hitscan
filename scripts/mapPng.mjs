// scripts/mapPng.mjs — rasterise a reference-map SVG to the committed PNG.
//
// docs/maps/*.png are the published artifact; the SVG from mapSvg.mjs is an
// in-memory intermediate only. Shipping SVG left the look up to each viewer:
// Qt SVG (Gwenview) ignores paint-order, so every haloed label drew its stroke
// over its glyphs, and system-ui resolved to a different face per machine.
// Rasterising here pins both — resvg is pinned to an exact version in
// package.json, system fonts are never loaded, and text resolves only against
// the Noto Sans files vendored in scripts/assets/fonts (SIL OFL 1.1, see
// OFL.txt beside them). Same inputs, same bytes, on any machine, which is what
// lets scripts/mapSvgs.test.mjs byte-compare the committed PNGs.
import { Resvg } from '@resvg/resvg-js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts');

/** Output width in px: the 960-unit drawing at 2x, crisp when zoomed. */
export const MAP_PNG_WIDTH = 1920;

/**
 * Render one map SVG document. `png` is the committed file's bytes; `pixels`
 * is the raw RGBA buffer (resvg always encodes RGBA, so the alpha bytes are
 * where the gate checks that the pocket/flag washes composited over the paper
 * rect to fully opaque pixels — translucency in, transparency never out).
 */
export function renderMapRaster(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: MAP_PNG_WIDTH },
    font: {
      loadSystemFonts: false,
      fontFiles: [join(FONTS, 'NotoSans-Regular.ttf'), join(FONTS, 'NotoSans-Bold.ttf')],
      defaultFontFamily: 'Noto Sans',
    },
  });
  const image = resvg.render();
  return { png: image.asPng(), pixels: image.pixels };
}

/** Render one map SVG document to PNG bytes. */
export function renderMapPng(svg) {
  return renderMapRaster(svg).png;
}
