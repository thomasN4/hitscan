"""Generate only the AK-47 source and studio previews; overwrites ak47.blend.

ALSOFT_DRIVERS=null blender --background --factory-startup --python-exit-code 1 --python scripts/assets/create-ak47-preview.py
"""
import runpy
from pathlib import Path

h = runpy.run_path(str(Path(__file__).with_name('create-remaining-weapons.py')))
box, cyl, profile, tube, cut, setup, assembly, barrel, guard, fixed_markers, validate_travel, save_and_render = (
    h[k] for k in ('box', 'cyl', 'profile', 'tube', 'cut', 'setup', 'assembly', 'barrel', 'guard',
                  'fixed_markers', 'validate_travel', 'save_and_render'))

steel, dark, wood, _, silver, _ = setup()
receiver = box('Stamped steel receiver', (.074,.073,.285), (0,-.078,.015), steel,.004)
cut(receiver, box('Action raceway',(.062,.029,.29),(0,-.064,.015),dark,0))
cut(receiver, box('Right ejection and charging slot',(.045,.025,.155),(.033,-.062,.018),dark,.001))
# The straight upper neck clears the well before the forward curve enters it.
cut(receiver, box('Magazine well',(.045,.090,.085),(0,-.112,-.075),dark,0))
cover = box('Rounded dust cover',(.073,.025,.245),(0,-.032,.03),steel,.010)
stock = profile('Solid walnut stock',[(.155,-.047),(.34,-.075),(.389,-.093),(.391,-.195),
    (.350,-.200),(.273,-.125),(.155,-.104)],.052,wood,.008)
box('Steel butt plate',(.057,.112,.013),(0,-.146,.393),steel,.003)
grip = profile('Walnut pistol grip',[(.073,-.112),(.125,-.112),(.173,-.235),(.115,-.236)],.043,wood,.006)
guard(.033,-.114,steel,silver,dark)
profile('Walnut lower handguard',[(-.296,-.073),(-.135,-.073),(-.135,-.116),(-.280,-.116),(-.296,-.100)],.058,wood,.006)
cyl('Walnut upper handguard',.021,.139,(0,-.051,-.216),wood)
cyl('Gas tube',.012,.185,(0,-.040,-.337),steel)
barrel('Long barrel',.014,.007,.285,(0,-.075,-.389),steel,dark)
barrel('Muzzle brake',.020,.009,.035,(0,-.075,-.525),steel,dark)
box('Gas block',(.036,.050,.027),(0,-.058,-.370),steel,.003)
for z in (-.294,-.140):
    box('Handguard retaining band',(.062,.050,.009),(0,-.091,z),steel,.002)
mag = profile('Curved thirty-round magazine', [(-.109,-.094),(-.041,-.094),(-.041,-.162),
    (-.057,-.219),(-.082,-.265),(-.115,-.304),(-.174,-.268),(-.140,-.222),(-.119,-.172)],.038,steel,.002)
mag_parts = [mag]
for side in (-1,1):
    for z in (-.097,-.072):
        mag_parts.append(tube('Magazine pressed rib',[(side*.020,-.147,z),(side*.020,-.198,z-.010),
            (side*.020,-.247,z-.034),(side*.020,-.277,z-.058)],.0012,dark))
assembly('mechanism_magazine',mag_parts)
slide = box('Bolt carrier',(.047,.019,.090),(0,-.063,.002),silver,.001)
handle = box('Right charging handle',(.048,.011,.018),(.039,-.063,.025),steel,.002)
assembly('mechanism_slide',[slide,handle])
# Rear notch and front post share y=0. Supports stay below the sight axis.
box('Rear sight leaf',(.039,.016,.050),(0,-.022,-.105),steel,.002)
for x in (-.024,.024):
    box('Rear notch shoulder',(.012,.018,.012),(x,-.009,-.090),dark,.001)
box('Front sight tower',(.029,.054,.024),(0,-.040,-.458),steel,.002)
box('Front sight post',(.005,.018,.008),(0,-.009,-.458),dark,.0004)
for x in (-.020,.020):
    box('Front sight protective ear',(.005,.035,.020),(x,-.0175,-.458),steel,.001)
fixed_markers((0,-.170,.121),(0,-.09,-.220),(0,-.075,-.543),
    (0,-.114,-.075),(0,-.235,0))
validate_travel(mag_parts,[receiver,cover,stock,grip],(0,-.235,0),'AK magazine')
validate_travel([slide,handle],[receiver,cover],(0,0,.045),'AK action')
save_and_render('ak47',(0,-.12,-.06),1.12)
