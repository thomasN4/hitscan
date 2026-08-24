# Loadout picker tranche — plan

Replace the fixed three-slot loadout (SMG/sniper/pistol always carried) with a
CS-style pick: one primary + one secondary, chosen in a menu that opens at
match start and at death.

## Decisions

- **Catalog over tuple.** `WEAPONS` becomes `Record<WeaponId, WeaponDef>` keyed
  by a literal union (`'smg' | 'sniper' | 'shotgun' | 'pistol' | 'revolver'`),
  which keeps the no-miss-indexing property the old tuple provided under
  `noUncheckedIndexedAccess` and lets new weapons register without touching
  consumers. Each def gains `class: 'primary' | 'secondary'`, which drives the
  picker columns and is validated by `setLoadout()`.
- **Positions vs weapons.** Keys `1`/`2` switch loadout POSITIONS
  (`wpn.slot: 0 | 1`); which weapon that is comes from the `loadout` slice via
  `equippedId()`. `ammoStore` becomes per-position. Q quick-swap semantics are
  unchanged (they already operated on positions).
- **One shared picker overlay** (`#loadoutScreen`) for both entry points:
  match start (after Play) and death (replacing the plain death screen),
  pre-filled from `lastLoadout`. Deploy click doubles as the user gesture
  pointer lock requires; Deploy respawns first when the player is dead.
  Pause deliberately offers no re-pick (locked until death, CS-like).
- **New weapons:** shotgun (8 pellets/trigger pull — `pellets` optional field;
  each ray sampled independently in the live cone; recoil/spray kick once per
  pull) and revolver (heavy semi-auto secondary). Procedural viewmodels +
  synthesized SFX per house rules.
- **Persistence:** last deployed loadout rides sessionStorage (`menu.ts` owns
  IO because `state.ts` stays Node-pure); `sanitizeLoadout()` in state.ts owns
  validation of the untrusted blob.

## Verification

- Unit: catalog class split, armLoadout/setLoadout/sanitizeLoadout, pellets
  balance intent (per-trigger-pull one-tap), validator gate over the whole
  catalog.
- Smoke test: picker-deploy through the real UI (Play → cards → Deploy);
  position-based switching phases rewritten around a deployed
  sniper/revolver pair; dedicated shotgun phase pins "one shell = one round,
  ~one hole per pellet".

## Review lessons

(Tranche open — lessons append below with repo-wide continuing numbers.)
