"""Headless posed review image; never saves changes to the editable source."""
import bpy
import math
from pathlib import Path
from mathutils import Vector
ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/source/arms.blend'))
rig = bpy.data.objects['Arms']
for side, sign in [('right', 1), ('left', -1)]:
    for name, angle in [('_upper', -.4 * sign), ('_forearm', 1.5 * sign)]:
        b = rig.pose.bones[side + name]
        b.rotation_mode = 'XYZ'
        b.rotation_euler.z = angle
    for i in range(4):
        for j in range(3):
            b = rig.pose.bones[f'{side}_finger_{i}_{j}']
            b.rotation_mode = 'XYZ'
            b.rotation_euler.x = -.7
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.background_type = 'WORLD'
scene.world.color = (.08,.09,.10)
camera_data = bpy.data.cameras.new('PreviewCamera')
camera = bpy.data.objects.new('PreviewCamera',camera_data)
scene.collection.objects.link(camera)
camera.location = (0,.35,2)
camera.rotation_euler = (Vector((0,.35,0))-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 1.0
scene.camera = camera
scene.render.resolution_x = 900
scene.render.resolution_y = 700
scene.render.resolution_percentage = 100
output = ROOT / 'assets/previews/arms.png'
output.parent.mkdir(parents=True,exist_ok=True)
scene.render.filepath = str(output)
bpy.ops.render.render(write_still=True)
