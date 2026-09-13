"""Build SMG, sniper and knife sources and studio previews (overwrites only these sources).

Run with Blender --background --factory-startup --python-exit-code 1 --python.
The existing pistol helpers are loaded without running its design generator.
All geometry is in game coordinates: metres, Y up, forward -Z.
"""
import math
import runpy
from pathlib import Path
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

helpers = runpy.run_path(str(Path(__file__).with_name('create-pistol-preview.py')))
box, cyl, profile, tube, cut, marker, material, setup, save_and_render = (
    helpers[k] for k in ('box', 'cyl', 'profile', 'tube', 'cut', 'marker', 'material', 'setup', 'save_and_render'))


def assembly(name, parts, pivot=(0, 0, 0)):
    parent = marker(name, pivot)
    bpy.context.view_layer.update()
    for obj in parts:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world
    return parent


def ring(name, radius, thickness, loc, mat):
    bpy.ops.mesh.primitive_torus_add(major_segments=40, minor_segments=8,
        location=loc, major_radius=radius, minor_radius=thickness)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def barrel(name, radius, bore, length, loc, steel, dark):
    obj = cyl(name, radius, length, loc, steel)
    cut(obj, cyl('Bore cutter', bore, length + .02, loc, dark))
    cyl('Recessed bore shadow', bore * .99, .001,
        (loc[0], loc[1], loc[2] - length / 2 + .065), dark)
    return obj


def guard(z, y, steel, silver, dark):
    outer = profile('Open trigger guard', [(z-.048,y),(z+.041,y),
        (z+.035,y-.055),(z-.030,y-.058),(z-.051,y-.038)], .018, steel, .002)
    cut(outer, profile('Guard cutter', [(z-.037,y-.008),(z+.031,y-.008),
        (z+.026,y-.044),(z-.025,y-.047),(z-.039,y-.033)], .05, dark, .001))
    tube('Curved trigger', [(0,y,z+.009),(0,y-.026,z+.001),(0,y-.035,z-.008)], .003, silver)


def fixed_markers(primary, support, muzzle, well=None, travel=None):
    marker('grip_right', primary)
    if support is not None:
        marker('grip_left', support)
    marker('Muzzle' if well is not None else 'blade_tip', muzzle)
    if well is not None:
        marker('reload_port', well)
        marker('magazine_out', Vector(well) + Vector(travel))


def validate_travel(moving, fixed, travel, label, pivot=None):
    """Intersect evaluated mesh surfaces throughout the actual mechanism sweep."""
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    def tree(obj, delta, angle):
        from mathutils import Matrix
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        rotation = Matrix.Rotation(angle, 4, 'Z')
        vertices = [evaluated.matrix_world @ v.co for v in mesh.vertices]
        if pivot is not None:
            vertices = [rotation @ (v-Vector(pivot)) + Vector(pivot) for v in vertices]
        vertices = [v+delta for v in vertices]
        result = BVHTree.FromPolygons(vertices, [tuple(p.vertices) for p in mesh.polygons])
        evaluated.to_mesh_clear()
        return result
    obstacles = [tree(obj, Vector((0,0,0)), 0) for obj in fixed]
    for i in range(101):
        t = i/100
        # Bolt lifts before pulling; also check combined charge rotation/travel.
        for angle, distance in ([(1.15*t, 0), (1.15, t), (1.15*t, t)] if pivot else [(0,t)]):
            for obj in moving:
                swept = tree(obj, Vector(travel)*distance, angle)
                for obstacle, fixed_obj in zip(obstacles, fixed):
                    assert not swept.overlap(obstacle), f'{label}: {obj.name}/{fixed_obj.name} collision at {i}%, angle {angle}'
    print(f'{label}: 101 evaluated mechanism poses clear')


def smg():
    steel, dark, _, _, silver, _ = setup()
    receiver = cyl('Tubular receiver', .038, .32, (0,-.055,.015), steel)
    cut(receiver, box('Action cavity',(.066,.050,.34),(0,-.055,.015),dark,0))
    cut(receiver, box('Right ejection opening',(.035,.026,.083),(.035,-.051,.055),dark,.002))
    lower = box('Lower receiver',(.074,.050,.28),(0,-.088,.012),steel,.005)
    well = box('Magazine well collar',(.056,.050,.080),(0,-.122,-.043),steel,.003)
    for part in (lower,well):
        cut(part,box('Magazine cavity',(.042,.14,.064),(0,-.130,-.043),dark,0))
    front = cyl('Ribbed fore-end',.031,.15,(0,-.055,-.21),dark)
    for z in [-.27+i*.012 for i in range(11)]:
        ring('Fore-end traction rib',.031,.0015,(0,-.055,z),steel)
    barrel('Open barrel',.016,.009,.19,(0,-.055,-.335),steel,dark)
    muzzle = barrel('Muzzle collar',.022,.010,.035,(0,-.055,-.414),steel,dark)
    grip = profile('Swept pistol grip',[(.065,-.109),(.132,-.109),(.201,-.242),(.140,-.247)],.050,dark,.006)
    for side in (-1,1):
        panel=profile('Grip inset',[(.087,-.132),(.127,-.132),(.178,-.228),(.144,-.230)],.002,steel,.002)
        panel.location.x=side*.026
        for i in range(7):
            y=-.149-i*.010
            z=.10+i*.005
            tube('Grip traction',[(side*.028,y,z),(side*.028,y-.004,z+.026)],.0008,dark)
        pin=cyl('Receiver takedown pin',.004,.003,(side*.039,-.087,.113),silver,24)
        pin.rotation_euler.y=math.pi/2
    profile('Skeleton stock',[(.16,-.043),(.37,-.054),(.398,-.176),(.349,-.176),
        (.306,-.087),(.16,-.077)],.034,steel,.005)
    box('Rubber butt pad',(.051,.152,.032),(0,-.12,.398),dark,.006)
    for y in [-.065-i*.015 for i in range(8)]:
        box('Butt pad groove',(.047,.002,.002),(0,y,.415),steel,.0005)
    guard(.047,-.112,steel,silver,dark)
    # Straight neck slides through the well; the curve begins below the collar.
    mag=profile('Curved magazine', [(-.070,-.100),(-.016,-.100),(-.016,-.185),
        (-.002,-.243),(-.017,-.310),(-.073,-.306),(-.057,-.243),(-.070,-.185)],.036,steel,.001)
    floor=box('Magazine floorplate',(.043,.012,.063),(0,-.311,-.044),dark,.002)
    mag_parts=[mag,floor]
    for side in (-1,1):
        for z in (-.055,-.030):
            mag_parts.append(tube('Magazine pressed flute',[(side*.0188,-.158,z),
                (side*.0188,-.204,z+.008),(side*.0188,-.251,z+.013),(side*.0188,-.294,z)],.0012,dark))
    assembly('mechanism_magazine',mag_parts)
    slide = box('Bolt visible through ejection opening',(.005,.022,.058),(.027,-.051,.050),silver,.001)
    handle=box('Charging handle',(.033,.012,.015),(-.049,-.048,-.094),steel,.002)
    cut(receiver,box('Charging handle slot',(.03,.015,.078),(-.034,-.048,-.072),dark,.001))
    assembly('mechanism_slide',[slide,handle])
    # Rear aperture surrounds a clear sight axis; the front post ends at y=0.
    box('Rear sight pedestal',(.044,.026,.035),(0,-.033,.14),steel,.002)
    ring('Rear aperture',.015,.003,(0,0,.14),dark)
    for x in (-.016,.016):
        box('Aperture foot',(.007,.030,.013),(x,-.024,.14),dark,.001)
    box('Front sight saddle',(.043,.019,.030),(0,-.026,-.27),steel,.002)
    box('Front sight post',(.008,.023,.012),(0,-.0115,-.27),dark,.0005)
    for x in (-.023,.023):
        box('Front sight wing',(.005,.037,.025),(x,-.016,-.27),steel,.001)
    fixed_markers((0,-.17,.135),(0,-.075,-.21),(0,-.055,-.432),
        (0,-.147,-.043),(0,-.235,0))
    validate_travel(mag_parts,[receiver,lower,well,grip],(0,-.235,0),'SMG magazine')
    validate_travel([slide,handle],[receiver,lower],(0,0,.045),'SMG action')
    save_and_render('smg',(0,-.12,-.01),1.03)


def sniper():
    steel,dark,_,_,silver,_=setup()
    olive=material('Olive composite',(.14,.19,.12))
    stock=profile('Olive composite stock',[(-.24,-.100),(.15,-.100),(.24,-.13),(.42,-.112),
        (.43,-.225),(.34,-.225),(.22,-.16),(.15,-.245),(.095,-.226),(.116,-.145),(-.24,-.15)],.062,olive,.005)
    cut(stock,box('Stock magazine opening',(.052,.12,.102),(0,-.137,-.045),dark,0))
    receiver=cyl('Receiver with bolt raceway',.027,.29,(0,-.072,-.025),steel)
    cut(receiver,cyl('Bolt raceway cutter',.020,.32,(0,-.072,-.025),dark))
    cut(receiver,box('Ejection port',(.05,.040,.095),(.021,-.055,-.006),dark,.002))
    cut(receiver,box('Bolt handle swept slot',(.085,.075,.043),(.025,-.052,.120),dark,0))
    barrel('Long precision barrel',.014,.0065,.50,(0,-.072,-.43),steel,dark)
    barrel('Recessed muzzle crown',.018,.008,.025,(0,-.072,-.68),steel,dark)
    box('Rubber recoil pad',(.076,.13,.027),(0,-.165,.435),dark,.007)
    profile('Raised cheek pad',[(.25,-.117),(.396,-.105),(.398,-.089),(.29,-.085),(.25,-.092)],.057,dark,.004)
    for side in (-1,1):
        for i in range(6):
            box('Fore-end vent',(.002,.010,.016),(side*.032,-.129,-.203+i*.025),dark,.001)
        panel=profile('Grip traction panel',[(.129,-.157),(.176,-.171),(.148,-.229),(.111,-.220)],.002,dark,.002)
        panel.location.x=side*.032
        for z in (.285,.380):
            pin=cyl('Stock hardware',.004,.002,(side*.033,-.135,z),silver,24)
            pin.rotation_euler.y=math.pi/2
    guard(.062,-.146,steel,silver,dark)
    mag=box('Detachable box magazine',(.044,.088,.092),(0,-.164,-.045),steel,.001)
    floor=box('Magazine floorplate',(.049,.009,.098),(0,-.212,-.045),dark,.001)
    mag_parts=[mag,floor]
    for side in (-1,1):
        for z in (-.070,-.023):
            mag_parts.append(box('Magazine pressed rib',(.001,.056,.005),(side*.0227,-.168,z),dark,.0004))
    assembly('mechanism_magazine',mag_parts)
    for z in (-.10,.09):
        box('Scope mount foot',(.035,.026,.034),(0,-.039,z),steel,.002)
        ring('Scope mounting ring',.024,.003,(0,0,z),steel)
    cyl('Scope tube',.023,.24,(0,0,0),dark)
    bpy.ops.mesh.primitive_cone_add(vertices=48,radius1=.042,radius2=.026,depth=.07,location=(0,0,-.16))
    obj=helpers['finish'](bpy.context.object,'Tapered objective bell',dark,.0007)
    cut(obj,cyl('Objective recess',.033,.030,(0,0,-.194),dark))
    cyl('Objective glass',.032,.002,(0,0,-.179),olive)
    eyepiece=cyl('Ocular housing',.033,.059,(0,0,.155),dark)
    cut(eyepiece,cyl('Eyepiece recess',.027,.019,(0,0,.183),dark))
    cyl('Ocular glass',.026,.002,(0,0,.174),olive)
    ring('Ocular metal rim',.030,.002,(0,0,.184),steel)
    for z in (.135,.143,.151,.159):
        ring('Focus grip ring',.033,.001,(0,0,z),steel)
    turret=cyl('Elevation turret',.012,.024,(0,.030,.005),dark)
    turret.rotation_euler.x=math.pi/2
    # Keep the side dial outside the existing ADS transition cone.
    dial=cyl('Windage turret',.011,.023,(.029,0,.005),dark)
    dial.rotation_euler.y=math.pi/2
    bolt=cyl('Blued steel bolt',.017,.12,(0,-.072,.080),steel)
    shaft=cyl('Bolt handle stem',.005,.043,(.036,-.072,.120),steel)
    shaft.rotation_euler.y=math.pi/2
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=.013,location=(.063,-.077,.120))
    knob=bpy.context.object
    knob.name='Bolt knob'
    knob.data.materials.append(dark)
    assembly('mechanism_bolt',[bolt,shaft,knob],(0,-.072,.120))
    fixed_markers((0,-.19,.14),(0,-.13,-.19),(0,-.072,-.693),
        (0,-.150,-.045),(0,-.18,0))
    validate_travel(mag_parts,[stock,receiver],(0,-.18,0),'Sniper magazine')
    validate_travel([bolt,shaft,knob],[stock,receiver],(0,0,.105),'Sniper bolt',(0,-.072,.120))
    save_and_render('sniper',(0,-.10,-.12),1.32)


def knife():
    steel,dark,_,_,silver,_=setup()
    # Full bevel facets taper from a central ridge to the sharpened perimeter.
    outline=[(-.051,-.032),(-.29,-.032),(-.413,-.065),(-.29,-.103),(-.051,-.103)]
    inner=[(-.057,-.049),(-.281,-.049),(-.378,-.065),(-.281,-.083),(-.057,-.083)]
    verts=[(0,y,z) for z,y in outline]
    for side in (-1,1):
        verts += [(side*.004,y,z) for z,y in inner]
    faces=[tuple(range(9,4,-1)),tuple(range(10,15))]
    for i in range(5):
        j=(i+1)%5
        faces += [(i,j,j+5,i+5),(j,i,i+10,j+10)]
    mesh=bpy.data.meshes.new('Faceted blade')
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    import bmesh
    bm=bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(mesh); bm.free()
    blade=bpy.data.objects.new('Clip-point blade with ground edge',mesh)
    bpy.context.collection.objects.link(blade)
    mesh.materials.append(silver)
    box('Steel tang',(.008,.044,.188),(0,-.066,.035),steel,.001)
    box('Beveled guard',(.050,.103,.020),(0,-.066,-.035),steel,.005)
    cyl('Rubber grip core',.028,.155,(0,-.066,.058),dark)
    for z in (.003,.024,.045,.066,.087,.108,.129):
        ring('Grip traction rib',.028,.002,(0,-.066,z),steel)
    cap=cyl('Pommel with lanyard hole',.032,.018,(0,-.066,.149),steel)
    hole=cyl('Lanyard cutter',.005,.08,(0,-.066,.149),dark,24)
    hole.rotation_euler.y=math.pi/2
    cut(cap,hole)
    fixed_markers((0,-.066,.058),None,(0,-.065,-.413))
    save_and_render('knife',(0,-.065,-.126),.70)


if __name__ == '__main__':
    import sys
    selected = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['smg','sniper','knife']
    for name in selected:
        {'smg': smg, 'sniper': sniper, 'knife': knife}[name]()
