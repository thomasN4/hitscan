"""Build editable weapon design candidates and studio previews, without runtime exports.

Run: ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 \
  --python scripts/assets/create-weapon-previews.py
Coordinates match the viewmodels: Y up, -Z muzzle direction, metres.
These are visual-review candidates; attachment markers are provisional.
"""
import math
from pathlib import Path
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/previews'
OUT.mkdir(parents=True, exist_ok=True)


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    return mat


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        modifier = obj.modifiers.new('Soft machined edges', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 3
    return obj


def box(name, size, loc, mat, bevel=.002):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, bevel)


def cyl(name, radius, depth, loc, mat, vertices=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = finish(bpy.context.object, name, mat, .0007)
    for p in obj.data.polygons:
        p.use_smooth = len(p.vertices) == 4
    return obj


def profile(name, points, width, mat, bevel=.003):
    # Side outline supplied as (forward-axis Z, vertical Y).
    n = len(points)
    verts = [(x,y,z) for x in (-width/2,width/2) for z,y in points]
    faces = [tuple(range(n-1,-1,-1)), tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name,mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj,name,mat,bevel)


def rounded_outline(points, steps=5):
    """Sample a closed Catmull-Rom silhouette for the sculpted stock wrist."""
    result=[]
    for i,p1 in enumerate(points):
        p0=Vector(points[i-1])
        p1=Vector(p1)
        p2=Vector(points[(i+1)%len(points)])
        p3=Vector(points[(i+2)%len(points)])
        for j in range(steps):
            t=j/steps
            result.append(tuple(.5*((2*p1)+(-p0+p2)*t+
                (2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)))
    return result


def tube(name, points, radius, mat, cyclic=False):
    curve=bpy.data.curves.new(name,'CURVE')
    curve.dimensions='3D'
    curve.resolution_u=16
    curve.bevel_depth=radius
    curve.bevel_resolution=3
    spline=curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points)-1)
    for p,co in zip(spline.bezier_points,points):
        p.co=co
        p.handle_left_type='AUTO'
        p.handle_right_type='AUTO'
    spline.use_cyclic_u=cyclic
    obj=bpy.data.objects.new(name,curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def cut(obj, cutter):
    bpy.context.view_layer.objects.active=obj
    # Apply bevel first, preserving the deliberate lip around the opening.
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    mod=obj.modifiers.new('Machined opening','BOOLEAN')
    mod.operation='DIFFERENCE'
    mod.object=cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for face in obj.data.polygons:
        face.use_smooth = False
    bpy.data.objects.remove(cutter,do_unlink=True)


def marker(name, loc):
    obj=bpy.data.objects.new(name,None)
    bpy.context.collection.objects.link(obj)
    obj.location=loc
    obj.empty_display_type='ARROWS'
    obj.empty_display_size=.035
    return obj


def setup():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    return (material('Charcoal blued steel',(.105,.13,.145)),
            material('Recess / rubber',(.025,.032,.037)),
            material('Warm walnut',(.36,.16,.075)),
            material('Walnut end grain',(.22,.084,.036)),
            material('Brushed steel',(.43,.49,.51)),
            material('Brass',(.62,.40,.12)))


def shotgun():
    steel,dark,wood,grain,silver,brass=setup()
    receiver=profile('Receiver', [(-.115,.022),(.12,.022),(.145,-.006),(.13,-.067),(-.11,-.067)], .058,steel,.006)
    cut(receiver,box('Ejection cutter',(.032,.030,.086),(.027,-.011,-.005),dark,.003))
    box('Bolt visible through ejection port',(.004,.023,.080),(.010,-.010,-.005),silver,.002)
    cut(receiver,box('Loading port cutter',(.035,.040,.082),(0,-.065,-.005),dark,.004))
    box('Loading well darkness',(.032,.002,.078),(0,-.034,-.005),dark)
    box('Shell lifter',(.020,.003,.065),(0,-.049,-.011),silver)
    barrel=cyl('Barrel',.018,.51,(0,.001,-.365),steel)
    cut(barrel,cyl('Bore cutter',.012,.52,(0,.001,-.365),dark))
    cyl('Magazine tube',.014,.39,(0,-.041,-.31),steel)
    cyl('Magazine cap',.017,.018,(0,-.041,-.514),dark)
    pump=cyl('Pump / sliding walnut fore-end',.030,.177,(0,-.036,-.289),wood)
    pump.scale.x=.92
    for i in range(9):
        bpy.ops.mesh.primitive_torus_add(major_radius=.0295,minor_radius=.0014,major_segments=48,minor_segments=8,location=(0,-.036,-.36+i*.018))
        obj=finish(bpy.context.object,f'Pump groove {i+1:02}',grain)
        obj.scale.x=.92
        obj.parent=pump
        obj.matrix_parent_inverse=pump.matrix_world.inverted()
    box('Pump action bar right',(.005,.011,.19),(.022,-.034,-.147),steel)
    box('Pump action bar left',(.005,.011,.19),(-.022,-.034,-.147),steel)
    profile('Walnut stock',rounded_outline([(.119,.013),(.147,.002),(.185,-.023),(.226,-.031),(.285,-.027),(.414,-.028),(.426,-.053),(.439,-.152),(.422,-.159),(.351,-.125),(.280,-.094),(.241,-.085),(.216,-.092),(.198,-.111),(.180,-.117),(.168,-.089),(.149,-.062),(.122,-.047)]),.050,wood,.009)
    profile('Recoil pad',[(.414,-.026),(.433,-.028),(.457,-.157),(.438,-.166)],.058,dark,.004)
    # Inlaid side grain marks remain restrained enough for illustrated rendering.
    for x in (-.0255,.0255):
        tube('Stock grain upper',[(x,-.044,.25),(x,-.043,.32),(x,-.049,.402)],.00055,grain)
        tube('Stock grain lower',[(x,-.065,.264),(x,-.076,.33),(x,-.120,.422)],.00055,grain)
    tube('Trigger guard',[(0,-.063,.028),(0,-.100,.037),(0,-.104,.092),(0,-.066,.112)],.005,steel)
    tube('Trigger',[(0,-.067,.072),(0,-.083,.066),(0,-.087,.056)],.0035,silver)
    box('Front bead pedestal',(.009,.012,.017),(0,.022,-.578),steel)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=.0035,location=(0,.031,-.578))
    finish(bpy.context.object,'Brass front bead',brass)
    for x in (-.0295,.0295):
        for z in (.05,.108):
            pin=cyl('Receiver pin',.0035,.0015,(x,-.035,z),silver,24)
            pin.rotation_euler.y=math.pi/2
    marker('Grip.Support.Pump',(0,-.047,-.289))
    marker('Grip.Primary.Stock',(0,-.073,.176))
    marker('Reload.LoadingPort',(0,-.068,-.005))
    marker('Mechanism.PumpTravel',(0,-.036,-.289))
    marker('Muzzle',(0,.001,-.62))


def loaded_chambers(brass, dark):
    """Seat a cartridge in every chamber so the rotor never reads as an empty gun.

    The chambers are bored straight through, so without these the player sees six
    black holes and daylight through the frame window. Static geometry: the rounds
    do not track ammo, they only have to look present. Shared with the one-off
    source edit that added them to the approved .blend, so both stay identical.
    """
    parts=[]
    for i in range(6):
        a=i*math.tau/6
        x=math.sin(a)*.026
        y=-.029+math.cos(a)*.026
        # Case stops 8 mm short of the chamber mouth: a seated round is recessed,
        # and the solid body is what kills the see-through.
        parts.append(cyl(f'Chamber case {i}',.0084,.052,(x,y,-.011),brass,24))
        # Rim stands proud of the rotor's rear face; .0105 against the .009 bore
        # leaves a 1.5 mm lip, which is the case head you actually read.
        parts.append(cyl(f'Chamber rim {i}',.0105,.0018,(x,y,.0159),brass,24))
        parts.append(cyl(f'Chamber primer {i}',.0038,.0012,(x,y,.0174),dark,16))
    return parts


def revolver():
    steel,dark,wood,grain,silver,brass=setup()
    frame=profile('Frame', [(-.068,.025),(.041,.025),(.066,-.008),(.057,-.067),(.020,-.086),(-.065,-.081)],.040,steel,.003)
    cut(frame,box('Cylinder window cutter',(.100,.080,.070),(0,-.027,-.014),dark,.001))
    barrel=cyl('Barrel',.016,.160,(0,-.003,-.139),steel)
    cut(barrel,cyl('Bore cutter',.0105,.17,(0,-.003,-.139),dark))
    box('Barrel top rib',(.024,.011,.160),(0,.013,-.139),steel,.0015)
    underlug=profile('Underlug',[(-.218,-.010),(-.058,-.010),(-.058,-.046),(-.198,-.046),(-.218,-.030)],.029,steel,.002)
    cut(underlug,cyl('Underlug bore clearance',.0105,.17,(0,-.003,-.139),dark))
    cylinder=cyl('Cylinder / six chamber rotor',.039,.060,(0,-.029,-.015),steel,72)
    for i in range(6):
        a=i*math.tau/6
        x=math.sin(a)*.026
        y=-.029+math.cos(a)*.026
        cut(cylinder,cyl(f'Chamber cutter {i}',.009,.070,(x,y,-.015),dark,24))
        # Shallow lengthwise scallops visibly articulate the rotor.
        x=math.sin(a)*.046
        y=-.029+math.cos(a)*.046
        cut(cylinder,cyl(f'Flute cutter {i}',.009,.039,(x,y,-.012),dark,24))
    cyl('Extractor hub',.010,.004,(0,-.029,.017),silver)
    loaded_chambers(brass,dark)
    box('Cylinder crane',(.012,.012,.072),(-.021,-.057,-.022),steel)
    cyl('Ejector rod',.004,.095,(-.012,-.034,-.095),silver)
    profile('Grip steel backstrap',[(.033,-.052),(.065,-.049),(.105,-.147),(.081,-.162),(.033,-.133),(.026,-.090)],.035,steel,.005)
    profile('Walnut grip',[(.036,-.071),(.066,-.066),(.097,-.143),(.080,-.153),(.039,-.131),(.027,-.098)],.046,wood,.007)
    for x in (-.024,.024):
        pin=cyl('Grip medallion',.004,.0015,(x,-.111,.060),brass,24)
        pin.rotation_euler.y=math.pi/2
        for i in range(4):
            tube('Grip carved line',[(x,-.094-i*.010,.043),(x,-.098-i*.010,.067+i*.004)],.0005,grain)
    tube('Trigger guard',[(0,-.070,-.045),(0,-.105,-.034),(0,-.109,.010),(0,-.071,.029)],.0035,steel)
    tube('Trigger',[(0,-.068,.005),(0,-.087,-.004),(0,-.091,-.014)],.0025,silver)
    profile('Hammer',[(.036,-.009),(.057,.036),(.075,.036),(.059,.009),(.051,-.027)],.013,steel,.001)
    box('Rear sight',(.022,.007,.015),(0,.030,.026),dark,.001)
    box('Front sight',(.005,.013,.017),(0,.025,-.205),dark,.001)
    box('Cylinder release',(.005,.013,.019),(-.022,-.021,.040),silver,.001)
    marker('Grip.Primary',(0,-.102,.061))
    marker('Mechanism.CylinderAxis',(0,-.029,-.015))
    marker('Mechanism.CranePivot',(-.021,-.057,.018))
    marker('Mechanism.HammerPivot',(0,-.018,.049))
    marker('Muzzle',(0,-.003,-.220))


def save_and_render(name, target, scale):
    scene=bpy.context.scene
    scene['Design status']='Model review candidate; no runtime integration or animation changes'
    scene['Coordinate convention']='Y up, -Z forward; metres'
    scene.render.engine='BLENDER_WORKBENCH'
    sh=scene.display.shading
    sh.light='STUDIO'
    sh.studiolight_rotate_z=.45
    sh.color_type='MATERIAL'
    sh.show_shadows=True
    sh.show_cavity=True
    sh.cavity_type='BOTH'
    sh.curvature_ridge_factor=1.25
    sh.curvature_valley_factor=1.1
    sh.show_object_outline=True
    sh.object_outline_color=(.025,.032,.039)
    sh.background_type='WORLD'
    scene.world.color=(.13,.155,.17)
    scene.render.resolution_x=1600
    scene.render.resolution_y=900
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    camdata=bpy.data.cameras.new('Review camera')
    camera=bpy.data.objects.new('Review camera',camdata)
    scene.collection.objects.link(camera)
    scene.camera=camera
    camdata.type='ORTHO'
    camdata.ortho_scale=scale
    target=Vector(target)
    for view,delta in [('hero',(1,.52,-.72)),('profile',(1,.08,0)),('underside',(.75,-.95,-.4))]:
        camdata.ortho_scale=scale * (1.3 if view=='underside' else 1)
        camera.location=target+Vector(delta)*scale
        direction=(target-camera.location).normalized()
        right=direction.cross(Vector((0,1,0))).normalized()
        up=right.cross(direction).normalized()
        camera.rotation_euler=Matrix((right,up,-direction)).transposed().to_euler()
        scene.render.filepath=str(OUT/f'{name}-{view}.png')
        bpy.ops.render.render(write_still=True)
        if view=='hero':
            bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/f'assets/source/{name}.blend'))

# Guarded so the chamber-loading helper above can be imported without rebuilding
# (and overwriting) the approved sources. Blender's --python runs this as __main__.
if __name__=='__main__':
    shotgun()
    save_and_render('shotgun',(0,-.035,-.080),1.23)
    revolver()
    save_and_render('revolver',(0,-.053,-.060),.48)
