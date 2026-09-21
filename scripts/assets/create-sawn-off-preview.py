"""Generate only sawnOff.blend: short side-by-side barrels on a break-action hinge."""
import math
import runpy
from pathlib import Path
import bpy

h = runpy.run_path(str(Path(__file__).with_name('create-remaining-weapons.py')))
box, cyl, profile, cut, marker, setup, assembly, guard, save_and_render = (
    h[k] for k in ('box', 'cyl', 'profile', 'cut', 'marker', 'setup', 'assembly', 'guard', 'save_and_render'))
steel, dark, wood, _, silver, brass = setup()
# Fixed breech face and tang sit behind the hinge's swept barrel assembly.
box('Breech receiver', (.083,.055,.065), (0,-.052,.0625), steel,.005)
profile('Cut walnut birdshead grip',[(.085,-.033),(.15,-.047),(.228,-.117),(.219,-.158),
    (.184,-.165),(.132,-.111),(.085,-.085)],.050,wood,.008)
for x in (-.026,.026):
    pin=cyl('Grip screw',.004,.002,(x,-.085,.145),silver,24)
    pin.rotation_euler.y=math.pi/2
box('Top release lever',(.013,.007,.045),(.012,-.020,.066),steel,.002)
guard(.047,-.082,steel,silver,dark)
# Two bored barrels; open at the breech and muzzle so the break exposes chambers.
before=set(bpy.context.scene.objects)
for x in (-.023,.023):
    tube=cyl('Short bored barrel',.022,.29,(x,-.032,-.120),steel)
    cut(tube,cyl('Bore cutter',.0115,.32,(x,-.032,-.120),dark))
    # Recessed dark bore lining leaves the muzzle and chamber visibly hollow.
    lining=cyl('Recessed bore lining',.0114,.19,(x,-.032,-.125),dark)
    cut(lining,cyl('Lining bore',.0108,.22,(x,-.032,-.125),dark))
box('Solid joining rib',(.015,.012,.282),(0,-.017,-.12),steel,.002)
profile('Short walnut fore-end',[(-.205,-.054),(.012,-.054),(.019,-.076),
    (-.19,-.083),(-.214,-.07)],.065,wood,.004)
box('Bead pedestal',(.006,.017,.009),(0,-.0065,-.248),steel,.001)
cyl('Brass bead',.003,.006,(0,.005,-.248),brass,24)
marker('grip_left',(0,-.075,-.14))
marker('reload_port',(0,-.032,.026))
marker('chamber_left',(-.023,-.032,.026))
marker('chamber_right',(.023,-.032,.026))
marker('Muzzle',(0,-.032,-.267))
assembly('mechanism_hinge',list(set(bpy.context.scene.objects)-before),(0,-.075,.026))
marker('grip_right',(0,-.101,.153))
# Rear shoulders leave the bead's y=.008 crest on a clear central axis.
for x in (-.020,.020):
    box('Rear sight shoulder',(.012,.025,.010),(x,-.0045,.057),steel,.001)
save_and_render('sawnOff',(0,-.06,-.025),.66)
