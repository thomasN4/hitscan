"""Create the standalone pistol review candidate and three studio renders.

Run: ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 --python scripts/assets/create-pistol-preview.py
This explicitly regenerates assets/source/pistol.blend; preserve manual edits first.
Game coordinates: metres, Y up, -Z forward. Visual asset only.
"""
import math
from pathlib import Path
import bpy
import bmesh
from mathutils import Matrix, Vector
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/previews'
OUT.mkdir(parents=True, exist_ok=True)
(ROOT / 'assets/source').mkdir(parents=True, exist_ok=True)


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
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name,mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj,name,mat,bevel)

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


def group(name, objects):
    parent = marker(name, (0, 0, 0))
    for obj in objects:
        obj.parent = parent
    return parent


def validate_magazine_fit(grip, mag, base):
    """Check evaluated geometry, including bevels, against the actual cut grip."""
    from mathutils.bvhtree import BVHTree
    bpy.context.view_layer.update()
    depsgraph=bpy.context.evaluated_depsgraph_get()
    def tree(obj, delta=Vector((0,0,0))):
        evaluated=obj.evaluated_get(depsgraph)
        mesh=evaluated.to_mesh()
        vertices=[evaluated.matrix_world @ v.co + delta for v in mesh.vertices]
        faces=[tuple(p.vertices) for p in mesh.polygons]
        result=BVHTree.FromPolygons(vertices,faces)
        evaluated.to_mesh_clear()
        return result, vertices
    shell,_=tree(grip)
    _,vertices=tree(mag)
    for v in vertices:
        if v.y < -.229:
            continue  # The neck and floorplate extend below the curved grip heel.
        for side in (-1,1):
            hit,_,_,distance=shell.ray_cast(v,Vector((side,0,0)),.1)
            assert hit is not None and distance > .001, 'Magazine protrudes through grip'
    for i in range(101):
        delta=Vector((0,-.180,.05760))*(i/100)
        for part in (mag,base):
            moving,_=tree(part,delta)
            assert not shell.overlap(moving), f'Magazine/grip intersection at extraction {i}%'
    print('PISTOL_FIT: rest containment and 101 extraction poses clear, bevels included')


def pistol():
    steel, dark, wood, grain, silver, brass = setup()
    slide_mat = material('Satin graphite slide', (.24, .30, .34))
    grip_mat = material('Slate grip panels', (.075, .10, .115))
    sight_mat = material('Ivory sight inserts', (.88, .79, .57))
    # The silhouette follows the existing procedural pistol, with a chamfered nose.
    slide = profile('Slide', [(-.149,-.030),(-.140,-.020),(.102,-.020),
        (.112,-.029),(.112,-.069),(-.142,-.069),(-.149,-.059)], .058, slide_mat, .003)
    cut(slide, box('Ejection port cutter',(.048,.029,.047),(.014,-.025,-.007),dark,.002))
    cut(slide, cyl('Muzzle clearance cutter',.013,.030,(0,-.044,-.147),dark))
    slide_parts=[slide]
    for x in (-.0293,.0293):
        for i in range(7):
            obj=box('Rear slide serration',(.0018,.030,.003),
                (x,-.046,.046+i*.008),dark,.0004)
            slide_parts.append(obj)
        for i in range(3):
            slide_parts.append(box('Front slide serration',(.0018,.027,.003),
                (x,-.046,-.109+i*.009),dark,.0004))
    slide_parts.append(box('Rear sight base',(.033,.005,.018),(0,-.016,.088),dark,.001))
    for x in (-.011,.011):
        slide_parts.append(box('Rear sight notch ear',(.010,.010,.013),(x,-.010,.088),dark,.001))
        slide_parts.append(box('Rear sight ivory index',(.003,.003,.001),(x,-.008,.095),sight_mat,.0004))
    slide_parts.append(box('Front sight',(.006,.012,.012),(0,-.010,-.126),dark,.001))
    slide_parts.append(box('Front sight ivory index',(.003,.004,.001),(0,-.008,-.1195),sight_mat,.0004))
    group('Mechanism.Slide',slide_parts)
    barrel=cyl('Barrel with open bore',.0115,.225,(0,-.044,-.040),silver)
    cut(barrel,cyl('Bore cutter',.0075,.235,(0,-.044,-.041),dark))
    box('Chamber visible through port',(.027,.014,.040),(0,-.037,-.007),silver,.0015)
    cyl('Bore shadow',.0074,.001,(0,-.044,-.094),dark)
    cyl('Recoil guide cap',.006,.005,(0,-.067,-.143),steel,32)
    profile('Frame dust cover',[(-.139,-.070),(.106,-.070),(.111,-.085),
        (.057,-.098),(-.128,-.098),(-.139,-.088)],.054,steel,.003)
    grip=profile('Grip frame',[(.043,-.083),(.099,-.080),(.147,-.223),
        (.134,-.236),(.083,-.232),(.046,-.133)],.049,dark,.005)
    # Parallel walls leave clearance for the magazine's bevels along the whole path.
    def magazine_profile(top, bottom, half_depth):
        def center(y):
            return .095 - .32 * (y + .170)
        return [(center(top)-half_depth,top),(center(top)+half_depth,top),
                (center(bottom)+half_depth,bottom),(center(bottom)-half_depth,bottom)]
    cut(grip,profile('Magazine well cutter',magazine_profile(-.102,-.260,.019),.038,dark,0))
    profile('Beavertail',[(.079,-.072),(.123,-.072),(.130,-.078),
        (.107,-.091),(.091,-.091)],.048,steel,.002)
    # The open guard is an extruded ring, not a solid block under the action.
    guard=profile('Trigger guard',[(-.069,-.093),(-.065,-.128),(-.048,-.145),
        (.040,-.145),(.060,-.114),(.055,-.091)],.020,steel,.003)
    cut(guard,profile('Guard opening',[(-.058,-.099),(-.055,-.125),
        (-.043,-.135),(.034,-.135),(.048,-.112),(.045,-.099)],.040,dark,.002))
    tube('Curved trigger',[(0,-.095,.020),(0,-.113,.014),(0,-.122,.004)],.003,silver)
    box('Trigger safety blade',(.002,.015,.003),(0,-.110,.010),dark,.0004)
    for side in (-1,1):
        panel=profile('Grip panel L' if side<0 else 'Grip panel R',
            [(.060,-.115),(.098,-.108),(.131,-.213),(.090,-.218)],.003,grip_mat,.002)
        panel.location.x=side*.025
        for i in range(9):
            y=-.128-i*.009
            z=.067+i*.0026
            tube('Grip traction groove',[(side*.027,y,z),(side*.027,y-.004,z+.030)],.00065,dark)
        for y,z in [(-.106,.068),(-.210,.108)]:
            pin=cyl('Frame pin',.0023,.0018,(side*.027,y,z),silver,24)
            pin.rotation_euler.y=math.pi/2
    box('Slide stop lever',(.006,.008,.031),(-.029,-.078,.035),silver,.001)
    box('Magazine release',(.005,.011,.010),(-.027,-.111,.051),steel,.001)
    mag=profile('Magazine body',magazine_profile(-.108,-.237,.016),.032,silver,.001)
    base=profile('Magazine floorplate',[(.089,-.237),(.134,-.237),(.137,-.246),(.092,-.246)],.047,dark,.001)
    group('Mechanism.Magazine',[mag,base])
    marker('Grip.Primary',(0,-.160,.098))
    marker('Grip.Support',(0,-.147,.060))
    marker('Reload.MagazineWell',(0,-.237,.11644))
    marker('Reload.MagazineOut',(0,-.417,.17404))
    marker('Muzzle',(0,-.044,-.153))
    bpy.context.scene['Mechanisms']='Slide moves along +Z; magazine extracts down and rearward along grip. No animation clips.'
    validate_magazine_fit(grip, mag, base)
    bpy.context.scene['Asset']='Original stylized semi-automatic pistol, visual game prop'
    # Make the file pleasant to open even outside camera view.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.region_3d.view_perspective='CAMERA'
    bpy.ops.object.select_all(action='DESELECT')
    slide.select_set(True)
    bpy.context.view_layer.objects.active=slide


if __name__ == '__main__':
    pistol()
    save_and_render('pistol',(0,-.124,-.002),.49)
