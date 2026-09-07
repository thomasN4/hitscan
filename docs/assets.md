# First-person arm assets

Editable source: `assets/source/arms.blend`. Runtime: `public/assets/arms.glb`.
The game retains procedural weapons/maps and synthesized audio. Blender is an
asset-authoring dependency, never a requirement for normal builds or deployment.

## Headless workflow

```sh
npm run assets:export
npm run assets:check
npm run build
```

`BLENDER=/absolute/path/to/blender` overrides the executable. Export opens the
edited source, preserves it, writes GLB, validates the result, then records
source/output/export-script SHA-256 hashes and settings in `assets/manifest.json`.
Commit source, GLB and manifest together. `assets:check` works without Blender.
The source-generation script is retained for provenance; explicitly invoking
`blender --background --factory-startup --python-exit-code 1 --python scripts/assets/create-arms.py`
**replaces the editable source**, so do not use it for routine exports.
The exporter disables audio via `ALSOFT_DRIVERS=null` for headless Linux machines.

The source is modeled in game coordinates: metres, Y up, -Z forward. Blender's
native Z-up convention is deliberately not used here. Export uses
`export_yup=False` to avoid rotating these coordinates a second time. Apply mesh
transforms before export; preserve identity transforms on the skeleton root.
Each arm has a 0.30 m upper arm and 0.29 m forearm, with rest bones along +Y.
Bone names and parentage are the loader contract; do not rename them casually.
Material slots are `sleeve`, `glove`, `panel`; the game maps these to cel materials.
No textures or animation clips are needed. Runtime IK and finger poses use the
existing gameplay clock; elbows bend without scaling either limb segment.

## Optional live connection

Tested: Blender 5.2.0 LTS, blender-mcp 1.9.1, add-on protocol 5.
The bridge was verified using MCP scene inspection and viewport capture. It
requires Blender's UI event loop and explicitly refuses `--background`. Following
the headless workflow preference, it is installed but not required or started by
any repository command. Use batch Python for normal work and browser screenshots
for final rendering checks. An interactive/virtual-display session is optional.

Machine setup (outside the repository):

```sh
BLENDERMCP_ADDONS_DIR="$HOME/.config/blender/5.2/scripts/addons" \
  uvx --python 3.11 blender-mcp==1.9.1 install-addon
codex mcp add blender --env BLENDER_MCP_DISABLE_TELEMETRY=1 -- \
  /absolute/path/to/uvx --python 3.11 blender-mcp==1.9.1
```

Enable “Interface: MCP for Blender” in Blender preferences. Disable **Allow
Telemetry** before starting its local server. The bridge defaults telemetry on;
initial setup verification exposed this and uploaded its first captures before
both the add-on preference and Codex environment were disabled. No external
asset-provider integrations are enabled. Restart the Codex task/app if newly
registered tools do not appear in an existing session.

The installed system Blender reports an OCIO 2.5 configuration / 2.4 library
mismatch and uses fallback color management. Geometry export is verified; final
palette approval uses the browser's cel renderer, not Blender's viewport colors.

## Review

Render a posed Blender preview without opening a window:

```sh
ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/preview-arms.py
```

It writes `assets/previews/arms.png` without changing the source. Export merges
editable pieces into three material meshes to keep skinning draw calls small.

Use `CS_SMOKE_BASE=http://127.0.0.1:5186 node scripts/weapon-animation-check.mjs /tmp/arms-poses`
with a dedicated Vite server. Inspect grip contact, sleeves at the wrist and
elbow, sight visibility, reload reaches, and skinned silhouettes. Test production
preview as well. Source and runtime assets are small enough to commit directly;
Blender backup files and temporary render output are excluded.
