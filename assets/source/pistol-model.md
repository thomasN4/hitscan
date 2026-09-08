# Pistol model candidate

`pistol.blend` is an original editable semi-automatic pistol for visual review.
It follows the existing pistol silhouette: satin graphite slide, dark frame,
slate grip panels, open guard, recessed muzzle, ejection port, and iron sights.

Coordinates are metres, Y up and -Z toward the muzzle. `Mechanism.Slide` and
`Mechanism.Magazine` parent the moving parts; named empties mark the two grips,
magazine well and muzzle. These are provisional attachment points for later
runtime integration. The file contains no animation clips or game wiring.
The studio camera is saved at the hero angle. Materials use flat colors and
Workbench cavity outlines; game cel-renderer appearance is not yet verified.

Recreate the candidate and hero, profile and underside PNGs with:

```sh
ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/create-pistol-preview.py
```

This command **overwrites pistol.blend**. Preserve manual edits before running
it again. It does not touch the shotgun or revolver. Renders are written to
`assets/previews/`. Tested with Blender 5.2.0 LTS.
