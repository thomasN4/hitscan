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
