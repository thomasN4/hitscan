"""Build the longbow source and studio previews (overwrites assets/source/longbow.blend).

Run: ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 --python scripts/assets/create-longbow.py

A self yew English longbow at brace, drawn at real size: 1.82 m nock to nock,
0.17 m brace height. Game coordinates: metres, Y up, -Z toward the target.
The origin is the arrow pass, where the shaft crosses the bow; the stave sits
just right of it, as it does for a right-handed archer's bow hand.

Only the stave is authored. The string and the nocked arrow move with the draw
every frame, so the game builds them (core/arrowModel.ts, weaponModels.ts),
the same split the reload cartridges already follow. The two limbs are
separate assemblies pivoting at the handle, so the draw can flex them; the
string markers ride on the limb tips.
"""
import math
import runpy
from pathlib import Path
import bpy
import bmesh

remaining = runpy.run_path(str(Path(__file__).with_name('create-remaining-weapons.py')))
assembly, marker, material, setup, save_and_render = (
    remaining[k] for k in ('assembly', 'marker', 'material', 'setup', 'save_and_render'))

STAVE_X = .020     # stave centre, right of the arrow pass
CENTRE_Y = -.030   # the bow's middle: the arrow crosses just above it
HANDLE = .060      # rigid half-length of the handle about CENTRE_Y
LIMB = .850        # each limb's vertical reach beyond the handle
DEFLECTION = .180  # how far the braced tips stand back toward the archer (+z)
SAMPLES = 36


def limb_centre(u):
    """Stave centreline (y offset past the handle, z) at u in [0, 1] along one limb."""
    return LIMB * u, DEFLECTION * u * u


def limb_frame(u):
    """Unit tangent and belly-ward normal (both in the y/z plane) at u."""
    dy, dz = LIMB, 2 * DEFLECTION * u
    n = math.hypot(dy, dz)
    return (dy / n, dz / n), (-dz / n, dy / n)


def section(u, belly):
    """Half of a D-section: width across x, depth toward the back or the belly.

    The back (sapwood, toward the target) is nearly flat, the belly
    (heartwood, toward the archer) fully rounded — the English war-bow section.
    """
    width = .030 - .017 * u
    depth = (.017 - .011 * u) * (1 if belly else .45)
    points = []
    for i in range(13):
        a = math.pi * i / 12
        points.append((width / 2 * math.cos(a), depth * math.sin(a)))
    return points


def loft(name, rings, mat):
    """Close a stack of equal-length vertex rings into one capped solid."""
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
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    return obj


def limb_half(name, sign, belly, mat):
    """One colour of one limb. sign = +1 upper, -1 lower; belly picks the half."""
    rings = []
    for k in range(SAMPLES + 1):
        u = k / SAMPLES
        ly, lz = limb_centre(u)
        (ty, tz), (ny, nz) = limb_frame(u)
        y0 = CENTRE_Y + sign * (HANDLE + ly)
        ring = []
        for sx, sd in section(u, belly):
            d = sd if belly else -sd
            ring.append((STAVE_X + sx, y0 + sign * ny * d, lz + nz * d))
        rings.append(ring)
    return loft(name, rings, mat)


def handle_half(name, belly, mat):
    rings = []
    for y in (CENTRE_Y - HANDLE, CENTRE_Y + HANDLE):
        ring = []
        for sx, sd in section(0, belly):
            ring.append((STAVE_X + sx, y, sd if belly else -sd))
        rings.append(ring)
    return loft(name, rings, mat)


def band(name, y0, y1, grow, mat, segments=24):
    """A wrap around the handle section, `grow` proud of the stave."""
    rings = []
    for y in (y0, y1):
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            ring.append((STAVE_X + (.015 + grow) * math.cos(a), y,
                         (.017 * (1 if math.sin(a) > 0 else .45) + grow) * math.sin(a)))
        rings.append(ring)
    return loft(name, rings, mat)


def horn_nock(name, sign, mat):
    """Tapered horn tip continuing the limb, with the string groove near its end."""
    ly, lz = limb_centre(1)
    (ty, tz), (ny, nz) = limb_frame(1)
    rings = []
    for k, (t, r) in enumerate([(0, .0068), (.012, .0074), (.030, .0062), (.042, .0040), (.050, .0012)]):
        cy = CENTRE_Y + sign * (HANDLE + ly + ty * t)
        cz = lz + tz * t
        ring = []
        for i in range(16):
            a = 2 * math.pi * i / 16
            ring.append((STAVE_X + r * math.cos(a), cy + sign * ny * r * math.sin(a), cz + nz * r * math.sin(a)))
        rings.append(ring)
    return loft(name, rings, mat)


def string_point(sign):
    """Where the string sits in the nock groove: belly side, 25 mm up the horn."""
    ly, lz = limb_centre(1)
    (ty, tz), (ny, nz) = limb_frame(1)
    t, r = .025, .0068
    return (STAVE_X, CENTRE_Y + sign * (HANDLE + ly + ty * t + ny * r), lz + tz * t + nz * r)


def longbow():
    setup()
    sapwood = material('Yew sapwood', (.66, .48, .26))
    heartwood = material('Yew heartwood', (.42, .16, .05))
    leather = material('Grip leather', (.13, .07, .035))
    horn = material('Horn', (.68, .62, .50))
    handle_half('Handle back', False, sapwood)
    handle_half('Handle belly', True, heartwood)
    # The arrow crosses the top of the bow hand; the wrap stops just below it.
    band('Leather grip wrap', CENTRE_Y - .075, -.006, .0025, leather)
    # A horn arrow plate caps the upper limb joint, where the flex would
    # otherwise open a hairline seam.
    band('Horn arrow plate', -.006, CENTRE_Y + HANDLE + .012, .0012, horn)
    for sign, label in ((1, 'upper'), (-1, 'lower')):
        parts = [limb_half(f'{label.title()} limb back', sign, False, sapwood),
                 limb_half(f'{label.title()} limb belly', sign, True, heartwood),
                 horn_nock(f'{label.title()} horn nock', sign, horn)]
        pivot = (STAVE_X, CENTRE_Y + sign * HANDLE, 0)
        limb = assembly(f'mechanism_limb{label.title()}', parts, pivot)
        point = marker('string_top' if sign > 0 else 'string_bottom', string_point(sign))
        point.parent = limb
        point.location = [a - b for a, b in zip(string_point(sign), pivot)]
    marker('grip_right', (STAVE_X, CENTRE_Y - .035, 0))
    marker('Muzzle', (0, 0, 0))
    save_and_render('longbow', (STAVE_X, CENTRE_Y, .09), 2.1)


if __name__ == '__main__':
    longbow()
