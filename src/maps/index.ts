// maps/index.ts — the MapName -> builder registry.
//
// One table so the set of maps is readable in one place, and so adding a map
// is a compiler-enforced step rather than a remembered one: BUILDERS is a full
// Record over the MapName union, so widening that union in core/state.ts fails
// to typecheck until the new builder is registered here. main.ts's dispatch
// used to be a hand-written if/else, which was the only place a MapName had to
// be spelled out that the compiler could NOT force you to update.
//
// Indexing needs no miss guard: a Record over a union is a mapped type with
// explicit properties, not an index signature, so noUncheckedIndexedAccess
// does not apply and BUILDERS[session.map] is a plain () => void — the same
// reason combat.ts:SPAWN_Z[session.map] needs none.
//
// Builders are browser-only (they touch the scene through world.ts) and each
// assumes a FRESH scene: map switching is a full page reload, never a runtime
// swap.
import type { MapName } from '../core/state';
import { buildArena } from './arena';
import { buildRange } from './range';
import { buildElevation } from './elevation';

/** Every map's geometry builder, keyed by the name the config query carries. */
export const BUILDERS: Record<MapName, () => void> = {
  arena: buildArena,
  range: buildRange,
  elevation: buildElevation,
};
