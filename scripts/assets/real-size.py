"""Bring the weapon sources to real-world size (see docs/assets.md, "Real-world size").

The first builds were drawn oversized: the pistol nearly as long as the
revolver, the SMG a quarter longer than any real one, the revolver's cylinder
twice a real cylinder's diameter. Each source is scaled uniformly about its
origin, which keeps every design proportion, marker and mechanism pivot, and
scales the sight line with the gun (weaponModels.ts reads that height back).
The revolver additionally trims its cylinder radially, which uniform scaling
cannot do without leaving the frame and barrel too small.

Run directly, it rescales the edited sources in place, once:

    ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 --python scripts/assets/real-size.py

The design generators call rescale_to_real_size() before saving, so a
regenerated source comes out at the same size. A scene property records the
applied factor; a second run is a no-op rather than a second shrink.
"""
from pathlib import Path
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]

# Uniform factor per source. Overall length after scaling, against the real
# weapon each one stands in for:
REAL_SIZE = {
    'pistol': .70,    # 0.21 m  (full-size service pistol, 0.19-0.22 m)
    'revolver': .85,  # 0.27 m; 0.32 m once its barrel is 7.5 in (create-weapon-previews.py)
    'sawnOff': .80,   # 0.39 m  (pistol-grip sawn-off); bore 18.4 mm = 12 gauge
    'smg': .80,       # 0.68 m  (MP5 / UMP, 0.68-0.69 m)
    'shotgun': .92,   # 0.99 m  (18-20 in pump gun, 0.99-1.0 m)
    'ak47': .935,     # 0.88 m  (AKM, 0.88 m)
}
# The sniper (1.14 m) and knife (0.30 m, issue #143) are already real-sized.

# After the uniform pass the cylinder is still 66 mm across on a 34 mm frame.
# The revolver is the one-headshot sidearm, a .44 Magnum: a six-shot N-frame
# cylinder is ~44 mm with ~11.7 mm chambers. Trimmed, this one is 50 mm with
# 11.5 mm chambers. About its own axis it stays round and keeps indexing; its
# length along the bore is untouched.
REVOLVER_CYLINDER_TRIM = .75
CYLINDER_PARTS = ('Cylinder / six chamber rotor', 'Extractor hub')
# Top chamber centre before any scaling: the chamber the crane swing exposes.
REVOLVER_LOAD_CHAMBER = (0, -.003, .019)

APPLIED = 'Real-size scale'


def scale_scene(s):
    """Scale every object and its geometry uniformly about the world origin.

    A uniform scale commutes with every rotation and scale, so conjugating each
    object's transforms by it only multiplies their translations. Geometry and
    absolute modifier/curve widths scale directly. Nothing else changes.
    """
    scaled = set()
    for obj in bpy.data.objects:
        obj.location = obj.location * s
        obj.delta_location = obj.delta_location * s
        inverse = obj.matrix_parent_inverse.copy()
        inverse.translation = inverse.translation * s
        obj.matrix_parent_inverse = inverse
        if obj.type == 'EMPTY':
            obj.empty_display_size *= s
        data = obj.data
        if data is None or data in scaled:
            continue
        scaled.add(data)
        if obj.type in ('MESH', 'CURVE'):
            data.transform(Matrix.Scale(s, 4))
        if obj.type == 'CURVE':
            data.bevel_depth *= s
            data.extrude *= s
        if obj.type == 'CAMERA':
            data.ortho_scale *= s
    for obj in bpy.data.objects:
        for mod in obj.modifiers:
            if mod.type != 'BEVEL':
                raise ValueError(f'Unscaled modifier {mod.type} on {obj.name}')
            if mod.offset_type != 'PERCENT':
                mod.width *= s


def bake_world(obj):
    """Move an unparented object's transform into its own (unshared) geometry."""
    if obj.parent is not None or obj.children:
        raise ValueError(f'Cannot bake parented part: {obj.name}')
    if obj.data.users > 1:
        obj.data = obj.data.copy()
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)


def trim_revolver_cylinder(k, s):
    # bake_world reads matrix_world, which is stale until the scaled locations
    # are evaluated.
    bpy.context.view_layer.update()
    axis = bpy.data.objects['Mechanism.CylinderAxis'].location.copy()
    radial = (Matrix.Translation(axis) @ Matrix.Diagonal((k, k, 1, 1))
        @ Matrix.Translation(-axis))
    parts = [bpy.data.objects[name] for name in CYLINDER_PARTS]
    parts += [o for o in bpy.data.objects if o.name.startswith('Chamber ')]
    if len(parts) <= len(CYLINDER_PARTS):
        raise ValueError('Revolver source has no seated chambers')
    for obj in parts:
        bake_world(obj)
        obj.data.transform(radial)
    # The frame window was cut for the full-size cylinder: close the gaps it
    # now leaves above and below, clear of the rotor so indexing never touches.
    # Each fill reaches 1 mm into the frame and stands 0.2 mm proud of its
    # sides, covering the window's bevelled lip instead of framing a panel.
    frame = bpy.data.objects['Frame']
    steel = frame.data.materials[0]
    radius = .039 * s * k
    lip = .001
    window = (-.067 * s - lip, .013 * s + lip)   # window cutter's y extent
    depth = (-.049 * s - lip, .021 * s + lip)    # and its z extent
    half_width = .020 * s + .0002                # frame half-thickness
    clearance = .0008
    for name, low, high in (
            ('Frame top strap', axis.y + radius + clearance, window[1]),
            ('Frame lower window', window[0], axis.y - radius - clearance)):
        bpy.ops.mesh.primitive_cube_add(size=1,
            location=(0, (low + high) / 2, (depth[0] + depth[1]) / 2))
        fill = bpy.context.object
        fill.name = name
        fill.scale = (2 * half_width, high - low, depth[1] - depth[0])
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        fill.data.materials.append(steel)
        bevel = fill.modifiers.new('Bevel', 'BEVEL')
        bevel.width = .001
        bevel.segments = 2
    # Loading marker for the exporter: the top chamber, moved with the trim.
    chamber = Vector(REVOLVER_LOAD_CHAMBER) * s
    chamber = radial @ chamber
    port = bpy.data.objects.new('Reload.Chamber', None)
    bpy.context.scene.collection.objects.link(port)
    port.location = chamber
    port.empty_display_size = .01


def rescale_to_real_size(name):
    """Scale the open scene to REAL_SIZE[name]; returns the factor (1 if none)."""
    s = REAL_SIZE.get(name, 1)
    scene = bpy.context.scene
    if s == 1:
        return 1
    if APPLIED in scene:
        if abs(scene[APPLIED] - s) > 1e-9:
            raise ValueError(f'{name} already scaled by {scene[APPLIED]}, not {s}')
        return s
    scale_scene(s)
    if name == 'revolver':
        trim_revolver_cylinder(REVOLVER_CYLINDER_TRIM, s)
    scene[APPLIED] = s
    bpy.context.view_layer.update()
    return s


if __name__ == '__main__':
    for weapon in REAL_SIZE:
        bpy.ops.wm.open_mainfile(filepath=str(ROOT / f'assets/source/{weapon}.blend'))
        rescale_to_real_size(weapon)
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / f'assets/source/{weapon}.blend'))
