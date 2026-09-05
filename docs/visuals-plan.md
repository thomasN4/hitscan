# Visual polish

## First pass: cel shading

Use one shared `createCelMaterial()` factory for lit world geometry, range
targets, bot bodies and weapons, and all six first-person weapons. The factory
uses Three.js's `MeshToonMaterial` with a procedural, nearest-filtered gradient:
three direct-light levels (0, 135/255, 1), with transitions at normal·light = 0
and 0.5. The darkest level spans both texels in the back-facing half of the
lookup, so surfaces facing away from the sun receive only ambient fill.

Keep map palettes, hemisphere fill, fog, and soft cast shadows. In particular,
warehouse2 still needs its stronger hemisphere light under the roof. The final
image is not limited to three colors: the ramp bands direct illumination, while
ambient lighting, shadows, fog, and textures still contribute to the result.
Use a small shadow normal offset (0.04 world units) to reduce self-shadowing
artifacts with the per-fragment toon shader.

Range labels, impact flashes, bullet holes, and debug lines keep their unlit
materials. The debug wireframe toggle continues to operate on level materials.
No outlines, new assets, postprocessing passes, or gameplay changes in this pass.

## Verification

- Run lint, typecheck, unit tests, and the production build.
- Run `scripts/smoke-test.mjs` against both dev and production preview servers;
  this includes all five maps, weapons, stairs/lifts, and the debug wireframe toggle.
- Compare matching camera views on main and the feature branch across all maps,
  including a view inside warehouse2; inspect weapon and bot shading as well.

The effect is clearest on curved surfaces and moving models as they cross a
lighting threshold. Static axis-aligned boxes already had flat faces under
Lambert lighting, and fully shadowed interiors still rely on the ambient fill.

## Arena study: ligne claire for an FPS

Open `/?map=arena&style=ligne-claire` for the study, or `/?map=arena` for the
original. This is a reload-based, opt-in arena treatment. The other four maps
ignore the style parameter. Changing match settings while staying on arena
preserves it; choosing another map or returning to the bare start URL clears it.
Rematch and reload preserve the current URL as before.

The direction is thin dark ink, warm plaster, terracotta shutters, a pale blue
sky, muted gunmetal, and distinct red/blue uniforms. Bright hemisphere fill and
a weaker directional light flatten the three-band material ramp while keeping
restrained cast shadows for depth. Buildings receive painted closed shutters,
doors and signs; crates receive planks and bracing. Bot faces and shirt pockets
appear only on their front faces. All six held weapons receive the palette and
ink treatment.

`core/ligneClaire.ts:initLigneClaire()` runs after world registration, navigation,
bot creation and respawn. It owns its render resources in a startup closure,
with no import-time DOM/engine access and no new shared mutable state. Existing
mesh/material names identify the surfaces to paint. Nothing changes the map's
geometry, collision boxes, hit zones, or world registries.

Ink uses cached `EdgesGeometry` at a 25-degree crease threshold and Three's
bundled `LineSegments2`, 1.35 CSS pixels wide. The viewport resolution is updated
on resize. Ink is depth-tested, does not write depth, has no raycast behavior,
and follows its parent through weapon swaps, reload animation, bot death and
respawn. Filled surfaces use a small polygon offset to keep coplanar strokes
visible. The diagnostic debug flag hides the extra ink. Procedural sRGB canvas
textures use mipmaps and up to 8x anisotropy for distant and oblique surfaces.

The first arena pass was an art-direction test on the existing box models. It
did not introduce smooth-model silhouettes (added for weapons below), remesh characters, redraw the HUD, or make
every painted detail maintain a constant screen-space line weight. It adds an
ink draw per outlined mesh, plus material groups on decorated boxes; performance
on the intended hardware still needs a playtest. Resources live for the page's
lifetime, matching the existing full-reload map lifecycle.

### Reproduce and inspect

```sh
npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
CS_SMOKE_BASE=http://127.0.0.1:5178 node scripts/ligne-claire-shots.mjs
CS_SMOKE_BASE=http://127.0.0.1:5178 CS_SMOKE_STYLE=ligne-claire node scripts/smoke-test.mjs
```

`ligne-claire-shots.mjs` writes matching original/styled courtyard and bot views,
all six held weapons, maximum sniper zoom and a resized DPR-2 view into
`/tmp/ligne-claire-shots` by default. It asserts identical collision bounds and
navigation node counts, ink present only in the styled arena, and no browser
errors or shader warnings. The debug screenshot exercises the V toggle on dev;
that binding is intentionally unavailable in production.

Run lint, typecheck, unit tests and build as usual. Point the same browser scripts
at a production preview server to check the bundled build. The smoke test's
optional `CS_SMOKE_STYLE` applies the query to every map and covers preserving
the arena style when match settings change. The overlay check recognizes Vite's
dev client: V must open the overlay in dev and remain inert in production, with
bot perception active in both. Run software-rendered browser suites serially;
competing instances can exhaust the smoke test's wall-clock timing allowances.
Check camera motion, stairs, distant
bots, weapon occlusion and reloads during a human playtest before broadening the
style to other maps.

## Weapon follow-up: shaped first-person props

Replace all six first-person box assemblies with procedural models in
`core/weaponModels.ts`. This geometry improvement applies on every map;
the illustrated palette and ink remain exclusive to the arena study URL.
Bot-held models remain the earlier simple silhouettes.

- SMG: tubular receiver, ribbed fore-end, curved magazine, shaped grip/stock,
  aperture sight and recessed muzzle.
- Sniper: tapered barrel, shaped stock, scope bells/mounts and bolt handle.
- Shotgun: paired barrel/magazine tubes, ribbed wooden pump, shaped stock and bead.
- Pistol: beveled slide/frame, slanted grip, ejection port, serrations and sights.
- Revolver: separate round cylinder with chamber marks, shaped grip and hammer.
- Knife: beveled clip-point blade, guard and ribbed round handle.

The factory returns the existing animated group, moving magazine/cylinder/shell
mesh and sight-alignment offset. Construction remains engine/DOM-free; weapon
selection, camera recoil, shot aim and reload timing stay in their existing
systems. The cosmetic reload pose now moves inward and rolls slightly upward,
keeping the remodeled prop visible instead of dropping it below the viewport.

Weapon parts carry a `weapon-part` name. The illustration pass gives these
65-degree crease ink plus a 1.05 CSS-pixel back-face silhouette hull. Hulls use
welded, averaged normals on a separate cached geometry; the visible surface
normals are unchanged. This avoids drawing every cylinder facet and bevel as
an interior ink line. Hulls follow parent visibility/animation, never cast
shadows or accept raycasts, and hide with the existing diagnostic flag. Their
resolution uniform shares the line pass's resize handling. World and bot ink
retain the first pass's 25-degree threshold.

The silhouettes are additional draws on the active first-person model; this
pass does not add arms, skeletal animations or a replacement asset pipeline.

```sh
CS_SMOKE_BASE=http://127.0.0.1:5178 \
CS_VIEWMODEL_QUERY='?map=arena&style=ligne-claire&tbots=1' \
node scripts/viewmodel-shots.mjs /tmp/weapon-poses
```

The updated capture tool equips real persisted loadouts and switches slots
through input, so weapon stats and HUD labels match the prop. It checks hip,
fully aimed, mid-reload and restored views for all five guns, plus knife hip
and inert ADS. It asserts reload completion and rejects browser/shader errors.
Omit `CS_VIEWMODEL_QUERY` for the range and point `CS_SMOKE_BASE` at production
preview to check the bundled version. Visually check that front/rear sights
meet the crosshair and that moving reload parts carry their ink without stray
lines. Run lint, typecheck, unit tests, build and the all-map smoke suite.
