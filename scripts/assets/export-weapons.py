"""Export approved edited weapon sources with named mechanism pivots and grips."""
import addon_utils
import bpy
import re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]

def gltf_addon_version():
    for mod in addon_utils.modules():
        if mod.__name__ == 'io_scene_gltf2':
            return '.'.join(str(part) for part in addon_utils.module_bl_info(mod)['version'])
    raise ValueError('Missing glTF exporter add-on: io_scene_gltf2')

def group(name, names, pivot):
    node=bpy.data.objects.new(name,None)
    bpy.context.scene.collection.objects.link(node)
    node.location=pivot
    bpy.context.view_layer.update()
    for name in names:
        obj=bpy.data.objects.get(name)
        if obj is None:
            raise ValueError('Missing source part: '+name)
        world=obj.matrix_world.copy()
        obj.parent=node
        obj.matrix_world=world
    return node

for weapon in ('shotgun','revolver','pistol','smg','sniper','knife'):
    bpy.ops.wm.open_mainfile(filepath=str(ROOT/f'assets/source/{weapon}.blend'))
    for obj in list(bpy.context.scene.objects):
        if obj.type in ('CAMERA','LIGHT'):
            bpy.data.objects.remove(obj,do_unlink=True)
    if weapon=='shotgun':
        group('mechanism_pump',['Pump / sliding walnut fore-end','Pump action bar right','Pump action bar left','Grip.Support.Pump'],bpy.data.objects['Mechanism.PumpTravel'].location)
        bpy.data.objects['Grip.Primary.Stock'].name='grip_right'
        bpy.data.objects['Grip.Support.Pump'].name='grip_left'
        bpy.data.objects['Reload.LoadingPort'].name='reload_port'
    elif weapon=='pistol':
        for source, target in [('Mechanism.Slide','mechanism_slide'),
                ('Mechanism.Magazine','mechanism_magazine'),('Grip.Primary','grip_right'),
                ('Grip.Support','grip_left'),('Reload.MagazineWell','reload_port'),
                ('Reload.MagazineOut','magazine_out')]:
            bpy.data.objects[source].name=target
    elif weapon=='revolver':
        # 'Chamber ' collects the seated cartridges; they have to index with the
        # rotor and swing out with the crane, not sit behind in the frame.
        chambers=sorted(o.name for o in bpy.context.scene.objects if o.name.startswith('Chamber '))
        rotor=group('mechanism_rotor',['Cylinder / six chamber rotor','Extractor hub']+chambers,bpy.data.objects['Mechanism.CylinderAxis'].location)
        crane=group('mechanism_cylinder',[rotor.name,'Cylinder crane','Ejector rod'],bpy.data.objects['Mechanism.CranePivot'].location)
        group('mechanism_hammer',['Hammer'],bpy.data.objects['Mechanism.HammerPivot'].location)
        bpy.data.objects['Grip.Primary'].name='grip_right'
        port=bpy.data.objects.new('reload_port',None)
        bpy.context.scene.collection.objects.link(port)
        port.location=(0,-.003,.019)
        bpy.context.view_layer.update()
        world=port.matrix_world.copy()
        port.parent=crane
        port.matrix_world=world
    for mat in list(bpy.data.materials):
        if mat.users == 0:
            bpy.data.materials.remove(mat)
    for mat in bpy.data.materials:
        mat.name=re.sub(r'\.\d{3}$','',mat.name)
    # Curves, bevels and booleans become ordinary meshes. Source stays editable.
    for obj in list(bpy.context.scene.objects):
        if obj.type in ('MESH','CURVE'):
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active=obj
            bpy.ops.object.convert(target='MESH')
    # Merge only siblings sharing a material; retain moving assembly boundaries.
    batches={}
    for obj in list(bpy.context.scene.objects):
        if obj.type=='MESH':
            key=(obj.parent,obj.data.materials[0].name)
            batches.setdefault(key,[]).append(obj)
    for (parent,mat),objects in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
        bpy.context.object.name='weapon_'+mat.replace(' ','_')
    bpy.ops.export_scene.gltf(filepath=str(ROOT/f'public/assets/{weapon}.glb'),export_format='GLB',export_yup=False,
        export_animations=False,export_texcoords=False,export_cameras=False,export_lights=False,export_extras=False)
print('ASSET_BLENDER_VERSION='+bpy.app.version_string)
print('ASSET_GLTF_ADDON_VERSION='+gltf_addon_version())
