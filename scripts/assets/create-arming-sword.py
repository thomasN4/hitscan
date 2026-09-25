"""Build the arming sword source and studio previews (overwrites assets/source/armingSword.blend).

Run: ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 --python scripts/assets/create-arming-sword.py

An Oakeshott type XII knightly sword drawn at real size: a 0.76 m blade of
lozenge section with a fuller down its first two thirds, tapering to a
thrusting point; a straight 0.20 m crossguard; a leather-wrapped grip and a
wheel pommel, 0.93 m overall. Game coordinates: metres, Y up, -Z forward,
the grip's centre at the origin. The edges lie along y, as they do in the
plow guard the viewmodel holds it in, so the flats face the sides.

The contract is the knife's: `grip_right` and `blade_tip` fixed at the root,
no mechanisms and nothing to load.
"""
import math
import runpy
from pathlib import Path
import bpy
import bmesh

remaining = runpy.run_path(str(Path(__file__).with_name('create-remaining-weapons.py')))
box, cyl, marker, material, setup, save_and_render = (
    remaining[k] for k in ('box', 'cyl', 'marker', 'material', 'setup', 'save_and_render'))

BLADE_BASE = -.060   # where the blade leaves the crossguard
BLADE_LENGTH = .760
FULLER_END = .66     # fraction of the blade the fuller runs down
SAMPLES = 40


def blade_ring(u):
    """Lozenge section at u in [0, 1] from the guard to the point: width along y, thickness along x."""
    width = .050 - .026 * u if u < .88 else (.050 - .026 * .88) * (1 - u) / .12
    thick = .0035 - .0017 * u
    width = max(width, .0006)
    thick = max(thick * min(1, width / .010), .0003)
    fuller = .45 if u < FULLER_END else 1  # the groove leaves the ridge sunken
    z = BLADE_BASE - BLADE_LENGTH * u
    return [(0, width / 2, z), (thick, width * .18, z), (thick * fuller, 0, z), (thick, -width * .18, z),
            (0, -width / 2, z), (-thick, -width * .18, z), (-thick * fuller, 0, z), (-thick, width * .18, z)]


def blade(mat):
    rings = [blade_ring(k / SAMPLES) for k in range(SAMPLES + 1)]
    n = len(rings[0])
    verts = [v for ring in rings for v in ring]
    faces = []
    for r in range(len(rings) - 1):
        a, b = r * n, (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    mesh = bpy.data.meshes.new('Lozenge blade with fuller')
    mesh.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('Lozenge blade with fuller', mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    return obj


def arming_sword():
    steel, _, _, _, silver, _ = setup()
    leather = material('Grip leather', (.13, .07, .035))
    blade(silver)
    # Straight cross, a little thicker at its block than at its arms.
    box('Crossguard block', (.024, .034, .020), (0, 0, -.058), steel, .003)
    box('Crossguard arms', (.016, .200, .014), (0, 0, -.058), steel, .004)
    cyl('Leather-wrapped grip', .0155, .096, (0, 0, 0), leather)
    for z in (-.036, .036):
        cyl('Grip ferrule', .0165, .008, (0, 0, z), steel)
    pommel = cyl('Wheel pommel', .027, .020, (0, 0, .070), steel)
    pommel.rotation_euler.y = math.pi / 2
    cyl('Peened tang button', .006, .010, (0, 0, .095), steel, 24)
    marker('grip_right', (0, 0, 0))
    marker('blade_tip', (0, 0, BLADE_BASE - BLADE_LENGTH))
    save_and_render('armingSword', (0, 0, -.36), 1.05)


if __name__ == '__main__':
    arming_sword()
