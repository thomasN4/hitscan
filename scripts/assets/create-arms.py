"""Author the editable arm source. Only run intentionally; export preserves edits.
Coordinates are game-native metres, +Y along rest bones, -Z forward.
"""
import bpy
import math
from pathlib import Path
from mathutils import Vector, Quaternion

ROOT = Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.preferences.filepaths.save_version = 0

def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*[v / 255 for v in rgb], 1)
    return m
cloth = material('sleeve', (98, 105, 84))
glove = material('glove', (52, 59, 60))
panel = material('panel', (82, 91, 88))
armature = bpy.data.armatures.new('ArmSkeleton')
rig = bpy.data.objects.new('Arms', armature)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')

def bone(name, head, tail, parent=None):
    b = armature.edit_bones.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = armature.edit_bones[parent]
    return name

for side, x in [('right', .18), ('left', -.18)]:
    upper = bone(side + '_upper', (x, 0, 0), (x, .30, 0))
    fore = bone(side + '_forearm', (x, .30, 0), (x, .59, 0), upper)
    wrist = bone(side + '-hand', (x, .59, 0), (x, .655, 0), fore)
    for i in range(4):
        fx = x + (i - 1.5) * .014
        parent = wrist
        length = .018 if i == 3 else .022
        for j in range(3):
            y = .65 + j * length
            parent = bone(f'{side}_finger_{i}_{j}', (fx, y, 0), (fx, y + length, 0), parent)
    tx = x + (-1 if side == 'right' else 1) * .034
    bone(side + '_thumb', (tx, .613, 0), (tx, .65, 0), wrist)
bpy.ops.object.mode_set(mode='OBJECT')

# Ring lofts give continuous sleeve topology and a soft transition across the
# elbow, with extra rings around the bend instead of a cylinder scaled to fit.
def loft(name, rings, mat, weights, center_x=0, flatten=1):
    verts, faces = [], []
    sides = 16
    for y, radius in rings:
        for i in range(sides):
            a = 2 * math.pi * i / sides
            verts.append((center_x + radius * math.cos(a), y, radius * math.sin(a) * flatten))
    for j in range(len(rings) - 1):
        for i in range(sides):
            a, b = j * sides + i, j * sides + (i + 1) % sides
            faces.append((a, a + sides, b + sides, b))
    faces.extend([tuple(range(sides)), tuple((len(rings)-1)*sides+i for i in reversed(range(sides)))])
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for p in mesh.polygons:
        p.use_smooth = True
    for index, v in enumerate(verts):
        for bn, weight in weights(v[1]):
            if weight <= 0:
                continue
            group = obj.vertex_groups.get(bn) or obj.vertex_groups.new(name=bn)
            group.add([index], weight, 'REPLACE')
    modifier = obj.modifiers.new('Skin', 'ARMATURE')
    modifier.object = rig
    obj.parent = rig
    return obj

for side, x in [('right', .18), ('left', -.18)]:
    def sleeve_weights(y):
        t = min(1, max(0, (y - .265) / .07))
        return [(side + '_upper', 1-t), (side + '_forearm', t)]
    loft(side + '_sleeve', [(0,.064),(.025,.066),(.12,.061),(.23,.052),(.265,.048),
         (.283,.047),(.30,.046),(.317,.046),(.335,.047),(.39,.050),(.46,.044),(.54,.033),(.579,.030)], cloth, sleeve_weights, x, .9)
    loft(side + '_cuff', [(.551,.034),(.556,.035),(.58,.032),(.59,.030)], panel,
         lambda y: [(side + '_forearm',1)], x, .9)
    loft(side + '_glove', [(.577,.027),(.59,.029),(.608,.035),(.636,.034),(.65,.029)], glove,
         lambda y: [(side + '-hand',1)], x, .52)
    for i in range(4):
        length = .018 if i == 3 else .022
        fx = x + (i-1.5)*.014
        for j in range(3):
            y = .65 + j*length
            bn = f'{side}_finger_{i}_{j}'
            loft(bn + '_mesh', [(y-.002,.006),(y+.003,.007),(y+length-.003,.0065),(y+length,.004)], glove,
                 lambda y, bn=bn: [(bn,1)], fx, .95)
    tx = x + (-1 if side == 'right' else 1)*.034
    loft(side + '_thumb_mesh', [(.611,.011),(.623,.012),(.645,.010),(.653,.005)], glove,
         lambda y: [(side + '_thumb',1)], tx)
    # Back-of-hand padded inset, weighted to the wrist.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(x,.625,.018))
    obj = bpy.context.object
    obj.name = side + '_knuckle_panel'
    obj.scale = (.026,.020,.004)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.materials.append(panel)
    vg = obj.vertex_groups.new(name=side + '-hand')
    vg.add(list(range(len(obj.data.vertices))),1,'REPLACE')
    obj.modifiers.new('Skin','ARMATURE').object = rig
    obj.parent = rig

# Comfortable framing when opening the editable source in Blender.
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_distance = 1.25
            area.spaces.active.region_3d.view_location = Vector((0,.35,0))
            area.spaces.active.region_3d.view_rotation = Quaternion((1,0,0,0))
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets/source/arms.blend'))
