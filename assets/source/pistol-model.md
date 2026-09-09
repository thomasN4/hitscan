# Pistol model

`pistol.blend` is an original editable semi-automatic pistol for the authored first-person viewmodel.
It follows the existing pistol silhouette: satin graphite slide, dark frame,
slate grip panels, open guard, recessed muzzle, ejection port, and iron sights.

Coordinates are metres, Y up and -Z toward the muzzle. `Mechanism.Slide` and
`Mechanism.Magazine` parent the moving parts; named empties mark the two grips,
magazine well, full extraction position, and muzzle. Export maps these names
to the runtime rig. The game animates the assemblies; there are no baked clips.
The studio camera is saved at the hero angle. Materials use flat colors and
Workbench cavity outlines. The runtime palette uses the game cel renderer.

Recreate the candidate and hero, profile and underside PNGs with:

```sh
ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/create-pistol-preview.py
```

This command **overwrites pistol.blend**. Preserve manual edits before running
it again. It does not touch the shotgun or revolver. Renders are written to
`assets/previews/`. Tested with Blender 5.2.0 LTS.

The fitted magazine follows the cut well along `(0, -0.180, 0.05760)` metres.
The generator verifies rest containment and 101 extraction poses against the
beveled geometry. The exposed floorplate remains below the grip.
