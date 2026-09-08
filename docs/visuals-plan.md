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

## Weapon follow-up: hands and mechanisms

The next pass adds procedural charcoal gloves, articulated fingers and olive
sleeves to all six first-person rigs. The current sniper is now deliberately
bolt-action: its existing shot interval, forced unscoping and scope gate remain.
There is no extra sniper catalog entry or asset archive. The revolver hammer is
lowered below the sight line; the shotgun's red/brass loading shell is hidden
outside insertion phases.

`WeaponViewModel` now exposes typed mechanism assemblies, saved rest transforms,
hands and interaction anchors instead of a universal moving `mag`. The pump,
bolt handle, pistol slide, SMG charging handle, cylinder and hammer move with
all their child details and ink. `core/weaponHands.ts` constructs the glove
joints and sleeves; `core/weaponPresentation.ts` applies absolute poses and
keeps forearms connected to their wrist targets. The bolt hand target follows
the rotating handle. Reload poses turn the shotgun to expose the loading port.

`sim/weaponAnimation.ts` evaluates pure pose envelopes from game time and actual
shot/reload event clocks. The weapon-owned animation state lives in `wpn` and
resets on swaps, loadout changes and respawn. `weapons.ts` applies poses after
this frame's ammo transfers and trigger handling, preserving the main stage
order. No animation creates a shot, moves ammo or adds a readiness delay.

- Shotgun: support-hand pump cycle finishes inside the existing 0.9-second
  firing interval; individual shells enter the underside loading port.
- Revolver: cylinder swing-out, individual-round insertion, cylinder indexing
  and hammer motion. It stays open between transfers and closes on the final
  round or reserve exhaustion. An interrupting shot restores the firing pose
  immediately and uses only rounds already transferred.
- Sniper: unlock, pull, return and lock the bolt inside the existing 1.1-second
  shot interval; the right hand follows the handle. Detachable-magazine reload.
- SMG/pistol: magazine removal and seating with support-hand motion; slide or
  charging-handle movement after firing and on empty reloads.
- Knife: gripping hands and a hit-frame follow-through with recovery.
- All six: restrained idle motion, sprint lowering and cosmetic holster/draw.
  The 80-ms lowering and subsequent raise are overridden by aiming, reloading
  or a successful shot, so selection remains mechanically immediate.

Reload sounds use their weapon's duration. Pump/bolt clacks emit on game-clock
milestone crossings; no wall-clock mechanism callbacks survive cancellation.
Pause freezes hands, mechanisms, reload props and sound progression together.
The existing `semiAuto` catalog flag is an input latch (one shot per press), so
it remains true for the manually operated sniper and shotgun.

Verification includes pure cycle/transfer/transition tests, loadout-reset tests,
and a real-input browser capture suite:

```sh
CS_SMOKE_BASE=http://127.0.0.1:5180 \
  node scripts/weapon-animation-check.mjs /tmp/weapon-animation-poses
```

Optional weapon IDs after the output directory select a subset. Set
`CS_SMOKE_STYLE=original` to check ordinary shading. The suite verifies actual
hammer vertices below the aimed sight line, both hands, pump/bolt travel,
pause stability, individual-round reload boundaries, fire cancellation, full
empty reloads, reserve exhaustion and rapid swaps. It captures hip, ADS, firing,
opening, insertion, seating and restored poses. Run it serially with the all-map
smoke suite against a dedicated production preview, plus lint, typecheck, unit
tests and build. Existing `viewmodel-shots.mjs` and `ligne-claire-shots.mjs` remain
available for the wider style comparison and resize/DPR checks.

## Blender arm pipeline follow-up

The earlier procedural glove/sleeve implementation above is superseded by a
Blender-authored skin with upper-arm, forearm, wrist and finger bones. The
source remains editable; headless export merges pieces by material into three
skinned meshes. `docs/assets.md` owns the source/export contract and local
Blender setup. Committed GLB and provenance hashes keep Blender out of normal
builds, while `npm test` checks the asset contract and source/output agreement.

Fixed-length two-bone IK replaces the old stretch-to-wrist cylinders. Camera-
relative shoulder anchors are tuned to reach the existing weapon grips; the
elbows can now enter the frame. Fingers, reload reaches and mechanism poses
still follow the pure game-clock envelopes. Skinned backface hulls follow the
same bones instead of drawing rest-pose crease lines.

Startup awaits the arm asset before viewmodel construction and menu activation.
An unavailable or incompatible asset leaves Play disabled with a retry message.
`node scripts/arm-assets-check.mjs` exercises missing/corrupt assets, single-load
behavior, independent skeletons and the real Deploy/respawn callback. The
weapon-animation capture suite also checks fixed bone scales and lengths and
captures sprint/swap poses alongside the existing shot/reload milestones.

### Shotgun reload choreography

The shotgun now raises and rolls around the receiver to expose its underside
loading port. Its left hand supports the rear of the pump while the right
retrieves, pinches and feeds each shell. The shell follows the loading wrist,
and the right fingers use a dedicated pinch rather than the trigger grip.
The receiver comes inward during the turn to keep the support target within
fixed arm reach. This presentation replaces the earlier left-hand shell feed;
other weapons and shotgun firing/pump timing are unchanged. Completion,
reserve exhaustion, shooting and sprint interruptions retain the existing
reload rules and restore the firing grip through the same pose reset path.

### Approved Blender weapons and attachment-driven reloads

The shotgun and revolver now use the reviewed Blender sources and committed
GLBs. The shotgun stock follows the supplied curved grip reference; the revolver
uses the approved heavier .44 Magnum proportions. Exported grip/loading markers
and moving mechanism parents are validated during startup and by the asset checks.

The shotgun reload brings the receiver inward, regrips the near pump surface,
and lets the support wrist follow the bent forearm while the right hand feeds
shells. This replaces the old rolled firing grip that crossed the receiver.
The revolver opens about its authored crane pivot, feeds the exposed chamber,
and indexes after the loading hand withdraws. Ammunition, fire rates, and
interruption rules retain their game-clock owners.

Verification adds exported hierarchy/independence tests, support forearm
clearance and wrist alignment checks, missing/corrupt weapon startup cases,
and captures under a non-root production base URL. Reproducible real-input reload
videos use `scripts/weapon-reload-video.mjs`; headless source previews use
`scripts/assets/create-weapon-previews.py` (a source-overwriting design generator).

## Arms removed from the viewmodel

The Blender-authored arms above are removed from the first-person rigs. This
supersedes the hands and Blender arm sections rather than rewriting them: the
implementation is in `81388c1`, `4ae6ac3` and `76fa8ba` if it is picked up again.

The reason is readability, not correctness. Screen recordings of every weapon's
aim/fire/reload cycle showed the hands reading as outline-less dark masses with
no finger separation, forearms tapering into the wrist with no cuff, and — on
half the weapons — hands outside the frame entirely. Measured NDC y of the hand
bones at rest: pistol -1.62/-1.60 and revolver -1.08/-1.09 (both hands below the
bottom edge), smg and sniper -1.06 for the trigger hand. All six shared one
camera-relative shoulder anchor pair, so which hands appeared was a side effect
of where each weapon sat rather than of any per-weapon authoring. The check
suite passed throughout, because it asserted the hand objects *existed* and
never that they were inside the frustum.

What stays: every mechanism animation (magazine, pump, bolt, slide, cylinder,
rotor, hammer), the pose envelopes in `sim/weaponAnimation.ts`, the authored
shotgun/revolver GLBs and their marker-driven reload trajectories, and the
startup asset gate — which the weapon GLBs still need, so an unavailable or
incompatible asset still leaves Play disabled with a retry message.

The loading shell and cartridge previously had their authored port trajectories
overwritten by the loading wrist position each frame. With no wrist, the
authored trajectory is what ships: each round travels into the port on its own.
`sim/weaponAnimation.ts` loses its `reach` envelope, which only ever drove hand
targets.

`weaponHands.ts`, `sim/armIK.ts`, the arm Blender source, its GLB, its manifest
and the `create-arms`/`export-arms`/`preview-arms` scripts are gone.
`scripts/assets/weapon-pipeline.mjs` now owns the `assets:export` / `assets:check`
CLI that the arm pipeline used to host, and `scripts/arm-assets-check.mjs` is
`scripts/weapon-assets-check.mjs`, checking viewmodel clone independence through
a mechanism node instead of a hand bone.

### Reload framing

The reload pose returns to its pre-arms form (`f62aa60`): the weapon tilts to the
right and dips slightly, and does not travel. Three terms added with the arms are
gone — a 0.12 m push down the view axis, an upward lift where the pre-arms pose
dipped, and a per-weapon reload yaw of 0.15 to 0.55 rad. All three existed to
hold a magwell or loading port inside a fixed arm's reach; without arms they only
shrink the prop and swing it off its own frame. The per-weapon reload roll
(0.48 pistol, -0.45 revolver, 0.30 otherwise) collapses back to a shared 0.28.

The revolver's negative roll is the reason its reload read as a shift rather than
a tilt: `vm.group` rotates about the camera origin, not about the weapon, so with
the other three terms reverted a -0.45 roll drops the silhouette to NDC y -1.41,
out of the bottom of the frame. It only survived because the lift and push-back
were compensating. The sign buys nothing on chamber visibility either — the
cylinder pivots about its own bore axis, so the chambers face the camera at 0.88
under +0.28 against 0.92 under -0.45.

The shotgun's reload raise drops from 66 to 37 degrees of pitch, with the
receiver held near its rest position and a smaller inward ease. The roll that
exposes the underside loading port is kept. At the old pitch the muzzle reached
NDC y 1.02 at the shotgun's 60-degree ADS fov — past the top edge — and
`scripts/shotgunPresentation.test.mjs` now sweeps the reload blend and pins the
muzzle and port inside the frame at that fov. The check fails at the old pose,
which is what makes it worth having. Mechanism animations and every reload
timing rule are untouched.

### Aiming locks the sight picture

`player.ts:updateViewmodel()` applied view bob and the rotational recoil kick to
`gunGroup` with no ADS gate, so while aimed the weapon rotated *inside* camera
space on top of the camera's own punch and its sights walked off the crosshair.
On the smg — the only full-auto weapon, so the one where `recoilYaw` random-walks
continuously — that was up to 0.03 rad of sight lift plus a lateral swim, against
a full-spray aim climb of 0.072 rad. This predates the arena work; `player.ts` is
unchanged from `main`. It became visible when the smg gained a real aperture
sight in `f62aa60`.

The arithmetic moves to `sim/viewmodelTransform.ts`, a pure seam in the pattern
`sim/recoil.ts:convertOnSwap` set, because `eslint.config.js` bans
`src/**/*.test.ts` from importing browser-side modules and this is the layer that
decides where the sights sit. Bob and the rotational kick now scale by
`1 - adsLerp`; hip fire is unchanged. The depth punch on z is deliberately not
gated: with x and y at their ADS values the sight sits on the view axis, and
translating along that axis leaves an on-axis point on it, so the punch is
NDC-neutral.

Fully gating the bob is a deliberate choice, not an oversight. `motion.bobAmt` is
weapon-only — there is no camera head-bob — so any residual is sights-versus-
crosshair error with no shared motion to read it against, and the existing idle
sine in `poseWeapon` is already taken to zero at full ADS by its `quiet` factor.
Aiming while walking is now perfectly still.

`sim/viewmodelTransform.test.ts` pins it, and `weapon-animation-check.mjs` holds
RMB to full ADS, drives recoil to the cap while walking for bob, and asserts the
rig's camera-space pose does not move. Both were written red first: the unit
suite fails three cases against the ungated formula, and the browser check reads
2.9e-2 against the ungated build versus a 5e-4 tolerance. The tolerance is not
zero because `adsLerp` approaches 1 asymptotically, leaving about 1e-4.
