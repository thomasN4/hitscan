# Weapon model candidates

`shotgun.blend` and `revolver.blend` are the approved editable weapon sources.
Their GLBs and hashes are produced by `npm run assets:export`; runtime
animations follow the exported grip markers and mechanism pivots.

Both use metres, Y up, and -Z toward the muzzle, matching the arm source and
viewmodel convention. Named objects separate the major mechanisms; attachment
empties define the runtime grip centers and mechanism pivots.

- Shotgun: curved semi-pistol-grip walnut stock and sliding fore-end, barrel and magazine tube,
  action bars, receiver with side ejection and underside loading openings,
  shell lifter, trigger and guard, and bead sight.
- Revolver: walnut grip, heavy frame and barrel, enlarged bore and six-chamber fluted cylinder,
  crane, ejector rod, hammer, trigger and guard, and iron sights.

Rebuild the initial candidates and their three review views with:

```sh
ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/create-weapon-previews.py
```

**This generator overwrites both `.blend` files.** Preserve manual source edits
before rerunning it. Renders go to ignored `assets/previews/`: `*-hero.png`,
`*-profile.png`, and `*-underside.png`. The saved source opens with its hero
camera; render it directly to preview subsequent manual source edits.

Tested with Blender 5.2.0 LTS, headless Workbench rendering. These studio renders
use material colors and cavity outlines; final engine cel shading remains a
later integration check. No textures, external asset services, or downloads are
required.

Second review revision: the shotgun stock wrist follows the user-supplied curved
grip reference. The revolver uses exaggerated .44 Magnum visual proportions
with a wider bore, longer and heavier barrel, and larger cylinder and chambers.
These are stylized game proportions, not dimensionally faithful replicas.
