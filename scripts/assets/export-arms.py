"""Export the edited source; never regenerate it as part of a normal export."""
import bpy
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/source/arms.blend'))
# Keep source pieces editable, but merge by material in the disposable export
# scene: three skinned draw calls rather than a draw call for every finger joint.
for material_name in ('sleeve', 'glove', 'panel'):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH'
              and len(obj.data.materials) == 1 and obj.data.materials[0].name == material_name]
    if not meshes:
        raise ValueError('Missing material group: ' + material_name)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    bpy.context.object.name = 'arms_' + material_name
# The source uses game coordinates already. Do not rotate Y-up a second time.
bpy.ops.export_scene.gltf(filepath=str(ROOT / 'public/assets/arms.glb'),
    export_format='GLB', export_yup=False, export_animations=False,
    export_skins=True, export_all_influences=False, export_def_bones=True,
    export_cameras=False, export_lights=False, export_extras=False)
print('ASSET_BLENDER_VERSION=' + bpy.app.version_string)
