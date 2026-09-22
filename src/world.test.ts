import { describe, expect, test, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  solids, colliders, navLinks, liftPads, resetWorld, stairLink, openTreadBase,
  createSolidBox, registerSolid, registerSolidBox, registerGroupParts, coplanarTopOverlaps,
} from './world';
import { collidesAt, HEAD_HEIGHT, STEP_HEIGHT } from './collision';

const box = (w = 1, h = 1, d = 1): THREE.Mesh =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());

beforeEach(resetWorld);

describe('registerSolidBox', () => {
  test('registers in BOTH registries', () => {
    // The `431ac6e` no-clip bug was exactly this: solids only, no collider.
    const mesh = box();
    registerSolidBox(mesh);
    expect(solids).toContain(mesh);
    expect(colliders).toHaveLength(1);
  });

  test('the AABB matches the mesh world position', () => {
    const mesh = box(2, 2, 2);
    mesh.position.set(10, 0, -5);
    registerSolidBox(mesh);
    const centre = colliders[0]!.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(10, 6);
    expect(centre.z).toBeCloseTo(-5, 6);
  });

  test('returns the mesh so callers can chain', () => {
    const mesh = box();
    expect(registerSolidBox(mesh)).toBe(mesh);
  });
});

describe('registerSolid', () => {
  test('adds a raycast target with NO movement AABB', () => {
    // Ground planes: bullets and decals need them, but an AABB would be a
    // zero-height box at y ~ 0 — always steppable, so it could never block
    // anything. Geometry with real height must NOT come through here.
    registerSolid(box());
    expect(solids).toHaveLength(1);
    expect(colliders).toHaveLength(0);
  });
});

describe('registerGroupParts', () => {
  /** A range-target-shaped group: parts positioned locally, group moved away. */
  function target(x: number, z: number) {
    const group = new THREE.Group();
    const post = box(0.15, 1, 0.15);
    const head = box(0.34, 0.34, 0.34);
    head.position.y = 2.0;
    group.add(post, head);
    group.position.set(x, 0, z);
    return { group, post, head };
  }

  test('resolves AABBs at the group world position, not the origin', () => {
    // `faa52c5`: Box3.setFromObject composes against the parent's CURRENT
    // matrixWorld, which is identity until the first render — so without the
    // flush every target's collision box landed at (0,0,0).
    const { group, post, head } = target(-4.5, -25);
    registerGroupParts(group, { shootable: [head], blocking: [post, head] });

    for (const c of colliders) {
      const centre = c.getCenter(new THREE.Vector3());
      expect(centre.x).toBeCloseTo(-4.5, 6);
      expect(centre.z).toBeCloseTo(-25, 6);
    }
  });

  test('and that assertion is not vacuous — without the flush they land at origin', () => {
    // Reproduces the pre-fix behavior directly, so the test above is known to
    // be testing something real.
    const { post } = target(-4.5, -25);
    const unflushed = new THREE.Box3().setFromObject(post);
    const centre = unflushed.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  test('honours the shootable/blocking asymmetry', () => {
    // A range target's post blocks walking but is not a bullet target.
    const { group, post, head } = target(0, -10);
    registerGroupParts(group, { shootable: [head], blocking: [post, head] });
    expect(solids).toEqual([head]);
    expect(solids).not.toContain(post);
    expect(colliders).toHaveLength(2);
  });

  test('defaults both lists to empty', () => {
    registerGroupParts(new THREE.Group(), {});
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
  });
});

describe('createSolidBox', () => {
  test('`y` is the BASE of the box, not its centre', () => {
    // The only line encoding this convention. Callers place walls and crates
    // by the ground they stand on, so a box of height 3 based at y=0 must
    // span 0..3 — not -1.5..1.5.
    registerSolidBox(createSolidBox(0, 0, 0, 2, 3, 2));
    expect(colliders[0]!.min.y).toBeCloseTo(0, 6);
    expect(colliders[0]!.max.y).toBeCloseTo(3, 6);
  });

  test('and that assertion is not vacuous — without the lift it straddles y=0', () => {
    // Reproduces the un-lifted behavior directly: BoxGeometry centred on the
    // origin sinks half its height below the floor.
    const mesh = createSolidBox(0, 0, 0, 2, 3, 2);
    mesh.position.set(0, 0, 0); // drop the + h / 2
    const sunk = new THREE.Box3().setFromObject(mesh);
    expect(sunk.min.y).toBeCloseTo(-1.5, 6);
  });

  test('a raised box is based at `y`, so it clears the ground', () => {
    // maps/arena.ts stacks crates this way: addSolidBox(-9, 3, ..., 3, 3, 3).
    registerSolidBox(createSolidBox(0, 3, 0, 3, 3, 3));
    expect(colliders[0]!.min.y).toBeCloseTo(3, 6);
    expect(colliders[0]!.max.y).toBeCloseTo(6, 6);
  });

  test('is pure — no scene, no registration', () => {
    const mesh = createSolidBox(0, 0, 0, 1, 1, 1);
    expect(mesh.parent).toBe(null);
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
  });
});

// stairLink — the endpoints navigation aims at.
//
// Every expectation below is the coordinate the MAP states in its own
// comments, not a number re-derived from the formula: maps/elevation.ts says
// its internal flight "tops out at exactly DECK_Y, flush with the slab's south
// edge at z = 0" and its external one lands "against the building at z = 12.5".
// If the arithmetic here and the geometry there ever disagree, bots route to a
// point no staircase reaches, and nothing else in the suite would notice.
describe('stairLink', () => {
  const STEP_H = 0.18, STEP_D = 0.3;

  test("elevation's internal flight: 20 risers to the slab's south edge", () => {
    const link = stairLink(4, 0, -6, 4, STEP_H, STEP_D, 20, 'z+');
    expect([link.bottom.x, link.bottom.y, link.bottom.z]).toEqual([4, 0, -6]);
    expect(link.top.x).toBeCloseTo(4, 12);
    expect(link.top.y).toBeCloseTo(3.6, 12); // DECK_Y
    expect(link.top.z).toBeCloseTo(0, 12);
  });

  test("elevation's external flight ascends z- to the building face", () => {
    const link = stairLink(8, 0, 18.5, 4, STEP_H, STEP_D, 20, 'z-');
    expect(link.top.y).toBeCloseTo(3.6, 12);
    expect(link.top.z).toBeCloseTo(12.5, 12);
  });

  test("elevation's tower flight abuts the tower's south face", () => {
    const link = stairLink(35, 0, 12.5, 4, STEP_H, STEP_D, 20, 'z-');
    expect(link.top.y).toBeCloseTo(3.6, 12);
    expect(link.top.z).toBeCloseTo(6.5, 12);
  });

  test("elevation's plateau flight ascends x- to the plateau's east face", () => {
    // 6 m wide, unlike the 4 m flights — navigation reads halfWidth to tell
    // which sampled nodes count as being ON the flight.
    const link = stairLink(-22.2, 0, -30, 6, STEP_H, STEP_D, 16, 'x-');
    expect(link.halfWidth).toBe(3);
    expect(link.top.x).toBeCloseTo(-27, 12);
    expect(link.top.y).toBeCloseTo(2.88, 12); // the plateau's lower tier
    expect(link.top.z).toBeCloseTo(-30, 12);
  });

  test("arena's flight reaches the 2.34 m platform", () => {
    const link = stairLink(26, 0, 26.1, 4, STEP_H, STEP_D, 13, 'z+');
    expect(link.top.y).toBeCloseTo(2.34, 12);
    expect(link.top.z).toBeCloseTo(30, 12);
  });

  test("warehouse1's south mezzanine flight lands on the slab's south edge", () => {
    // maps/warehouse1.ts: "14 - 6 = 8 south", flush with the slab edge at z = 8.
    const link = stairLink(0, 0, 14, 4, STEP_H, STEP_D, 20, 'z-');
    expect(link.top.y).toBeCloseTo(3.6, 12); // DECK_Y
    expect(link.top.z).toBeCloseTo(8, 12);
  });

  test("warehouse1's north mezzanine flight mirrors it across z = 0", () => {
    // The mirror is the map's fairness claim — if these two stop being
    // reflections, one team is closer to the high ground than the other.
    const south = stairLink(0, 0, 14, 4, STEP_H, STEP_D, 20, 'z-');
    const north = stairLink(0, 0, -14, 4, STEP_H, STEP_D, 20, 'z+');
    expect(north.top.y).toBeCloseTo(south.top.y, 12);
    expect(north.top.z).toBeCloseTo(-south.top.z, 12);
    expect(north.bottom.z).toBeCloseTo(-south.bottom.z, 12);
  });

  test("warehouse1's dock flight reaches the 1.08 m lip", () => {
    // 6 risers, not 20: the dock is a step-up height, so the flight exists
    // purely so bots (which cannot jump) are not shut out of it.
    const link = stairLink(24, 0, 43.2, 6, STEP_H, STEP_D, 6, 'z+');
    expect(link.halfWidth).toBe(3);
    expect(link.top.y).toBeCloseTo(1.08, 12);
    expect(link.top.z).toBeCloseTo(45, 12); // the dock platform's inner face
  });

  test('a flight based above ground carries its base into both ends', () => {
    const link = stairLink(0, 5, 0, 4, STEP_H, STEP_D, 4, 'x+');
    expect(link.bottom.y).toBe(5);
    expect(link.top.y).toBeCloseTo(5.72, 12);
    expect(link.top.x).toBeCloseTo(1.2, 12);
  });
});

describe('openTreadBase', () => {
  // maps/warehouse2.ts's two main flights: 28 risers of 0.18 on 0.06 plate.
  const STEP_H = 0.18, TREAD_T = 0.06, COUNT = 28;

  test('tread TOPS land exactly where a solid flight\'s step tops do', () => {
    // This is the whole contract. addStairs builds step i as a full-height box
    // topping out at (i + 1) * stepH; an open tread has to present the same
    // walking surface or climbing, descend-stick and the NavLink disagree
    // about where the flight is.
    for (let i = 0; i < COUNT; i++) {
      expect(openTreadBase(0, i, STEP_H, TREAD_T) + TREAD_T).toBeCloseTo((i + 1) * STEP_H, 12);
    }
  });

  test('consecutive treads stay one riser apart, so none reads as a wall', () => {
    for (let i = 1; i < COUNT; i++) {
      const rise = openTreadBase(0, i, STEP_H, TREAD_T) - openTreadBase(0, i - 1, STEP_H, TREAD_T);
      expect(rise).toBeCloseTo(STEP_H, 12);
      expect(rise).toBeLessThanOrEqual(STEP_HEIGHT + 1e-9);
    }
  });

  test('the flight is walk-under above a standing body, and solid below it', () => {
    // The reason these stairs exist: built solid they would be an 8.4 m wedge of
    // cover standing in the middle of warehouse2's void. Nothing implements
    // walk-under — collision.ts:blocks already ignores a collider whose
    // UNDERSIDE is at or above feet + HEAD_HEIGHT, so it falls out of the
    // tread heights alone, and this pins that it actually does.
    const tread = (i: number): THREE.Box3 => new THREE.Box3().setFromObject(
      createSolidBox(0, openTreadBase(0, i, STEP_H, TREAD_T), 0, 3.6, TREAD_T, 0.3));
    const blocks = (i: number): boolean =>
      collidesAt(new THREE.Vector3(0, 0, 0), 0.5, 0, [tread(i)]);

    // First tread whose plate hangs clear of a standing body's head (follows
    // HEAD_HEIGHT: bases run 0.12 + 0.18i, so 1.75 clears from tread 10).
    const firstOpen = Array.from({ length: COUNT }, (_, i) => i)
      .findIndex(i => openTreadBase(0, i, STEP_H, TREAD_T) >= HEAD_HEIGHT);
    expect(firstOpen).toBe(10);

    // Tread 0 is the step you take onto the flight, not a wall — its top is
    // one riser up, which collision.ts reads as floor.
    expect(blocks(0)).toBe(false);
    for (let i = 1; i < firstOpen; i++) expect(blocks(i)).toBe(true);
    for (let i = firstOpen; i < COUNT; i++) expect(blocks(i)).toBe(false);

    // The claim the design rests on: most of the run is open underneath.
    expect(COUNT - firstOpen).toBeGreaterThan(COUNT / 2);
  });
});

// coplanarTopOverlaps — the z-fighting the eye sees but the source hides.
//
// The case that motivated it: maps/warehouse2.ts built its catwalk decking out
// to the shell wall's CENTRE-line, so a 0.5 m strip of deck sat in the same
// plane as the wall top it buried. Both faces point up, both write the same
// depth, and three.js re-sorts opaque draws by distance every frame — so the
// winning material flipped as the player walked, and the catwalk port sills
// flickered between deck grey and wall grey.
describe('coplanarTopOverlaps', () => {
  /** A box spanning x/z, `top` metres tall — the shape this predicate reads. */
  const at = (minX: number, maxX: number, minZ: number, maxZ: number, top: number): THREE.Box3 =>
    new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, top, maxZ));

  test('finds two up-facing surfaces sharing a plane and a footprint', () => {
    // The warehouse2 sill, to scale: wall top and deck top both at 5.04,
    // overlapping over the wall's inner half-thickness.
    const found = coplanarTopOverlaps([at(29.5, 30.5, -6, 20, 5.04), at(22, 30, -12, 12, 5.04)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.y).toBeCloseTo(5.04, 6);
    expect(found[0]!.area).toBeCloseTo(0.5 * 18, 6);
    expect(found[0]!.minX).toBeCloseTo(29.5, 6);
    expect(found[0]!.maxX).toBeCloseTo(30, 6);
  });

  test('ignores tops at different heights', () => {
    expect(coplanarTopOverlaps([at(0, 10, 0, 10, 3), at(0, 10, 0, 10, 3.4)])).toHaveLength(0);
  });

  test('ignores boxes that share a plane but not a footprint', () => {
    expect(coplanarTopOverlaps([at(0, 10, 0, 10, 3), at(20, 30, 0, 10, 3)])).toHaveLength(0);
  });

  test('a butt join is not an overlap — this is the shape of the FIX', () => {
    // Decking stopping at the wall's inner face. The faces touch along a line
    // and share no area, which is exactly what the repair produces; a
    // predicate that flagged this would have no clean state to report.
    expect(coplanarTopOverlaps([at(29.5, 30.5, 0, 10, 5.04), at(22, 29.5, 0, 10, 5.04)])).toHaveLength(0);
  });

  test('tolerates float32 noise at map scale', () => {
    // Colliders are measured from float32 vertex data, where one ulp near 30 m
    // is ~2e-6. A join built to the same number twice must not read as a fight.
    const noise = 2e-6;
    expect(coplanarTopOverlaps([
      at(29.5, 30.5, 0, 10, 5.04),
      at(22, 29.5 + noise, 0, 10, 5.04 + noise),
    ])).toHaveLength(0);
  });

  test('a slab RESTING on a wall is fine — only tops are compared', () => {
    // The rail sits on the deck: its base is coplanar with the deck's top, but
    // the two faces point opposite ways and backface culling draws one of them.
    const deck = at(0, 10, 0, 10, 5.04);
    const rail = new THREE.Box3(new THREE.Vector3(0, 5.04, 0), new THREE.Vector3(10, 6.14, 10));
    expect(coplanarTopOverlaps([deck, rail])).toHaveLength(0);
  });

  test('reports every pair, not just the first', () => {
    const found = coplanarTopOverlaps([at(0, 10, 0, 10, 3), at(5, 15, 0, 10, 3), at(8, 20, 0, 10, 3)]);
    expect(found).toHaveLength(3);
  });

  test('an empty world has nothing to report', () => {
    expect(coplanarTopOverlaps([])).toHaveLength(0);
  });
});

describe('resetWorld', () => {
  test('empties every registry in place', () => {
    const before = { solids, colliders, navLinks, liftPads };
    registerSolidBox(box());
    navLinks.push(stairLink(0, 0, 0, 4, 0.18, 0.3, 4, 'z+'));
    liftPads.push({ minX: -2, maxX: 2, minZ: -2, maxZ: 2, topY: 0.15, launchVel: 17 });
    resetWorld();
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
    expect(navLinks).toHaveLength(0);
    expect(liftPads).toHaveLength(0);
    // Same array identities — importers hold references to these.
    expect(before.solids).toBe(solids);
    expect(before.colliders).toBe(colliders);
    expect(before.navLinks).toBe(navLinks);
    expect(before.liftPads).toBe(liftPads);
  });
});
