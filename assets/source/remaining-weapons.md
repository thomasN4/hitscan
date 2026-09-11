# SMG, sniper rifle and knife

`smg.blend`, `sniper.blend` and `knife.blend` are editable first-person weapon
sources. They retain the previous silhouettes with modeled openings, bevels,
recesses and separate moving assemblies. Runtime GLBs use the existing cel palette.

- SMG: tubular action, open ejection port, ribbed fore-end, curved magazine,
  swept grip, stock, open muzzle and aperture sights. The magazine has a straight
  neck fitted inside an open well; its curved section starts below the collar.
- Sniper: olive composite stock with cheek pad and recoil pad, long open barrel,
  tapered scope with recessed lenses, magazine well and bolt raceway. The bolt
  handle's receiver slot clears its lift before the rearward pull. The bolt body
  uses the receiver's blued-steel finish so it retains contrast in the cel palette.
- Knife: clip-point blade with broad ground bevel facets, guard, steel tang,
  ribbed rubber grip and a pommel with a lanyard opening.

Coordinates are metres, Y up and forward -Z. Moving assemblies already use the
export names: `mechanism_magazine`, `mechanism_slide` (SMG) and `mechanism_bolt`
(sniper). Firearms have fixed `grip_right`, `grip_left`, `reload_port`,
`magazine_out` and `Muzzle` markers. The knife has only `grip_right` and
`blade_tip`; no fake loading port or firearm action is required.

The SMG magazine extracts 235 mm downward, clearing its long neck. The sniper
magazine extracts 180 mm downward. These paths drive runtime presentation;
the rifles roll about their receivers to keep extraction visible, while
existing TypeScript clocks still determine reload completion and ammunition.
The SMG action moves 45 mm rearward; the sniper bolt lifts 1.15 radians about its
authored axis and pulls 105 mm rearward. There are no baked animation clips.

Regenerate sources and hero/profile/underside previews with:

```sh
ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/create-remaining-weapons.py
```

**This overwrites these three sources.** Preserve manual edits first. Append
`-- smg`, `-- sniper` or `-- knife` to rebuild only the selected weapon(s).
The generator imports helper functions from `create-pistol-preview.py` without
executing its pistol generator. It never regenerates the existing three sources.

The generator checks evaluated, beveled magazine geometry against the stock,
receiver and well through 101 extraction positions. It also checks the SMG
action and the sniper bolt's lift, pull and combined charge sweep. These are
surface-intersection checks against the modeled cavities, supplemented by
studio and runtime visual inspection. They are not a general solid-containment
or firearm-mechanics simulation.

Normal export uses `npm run assets:export` and preserves edited sources.
Commit the sources, GLBs and `assets/weapons-manifest.json` together.
Previews are ignored local files in `assets/previews/`.
