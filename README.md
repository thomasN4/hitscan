# Hitscan

A browser-based FPS demo inspired by Counter-Strike, built with [Three.js](https://threejs.org/) and Vite. Fight waves of AI bots in a dust-style arena with hitscan gunplay, iron sights, crouching, and synthesized audio — no asset files required.

## Quick start

```sh
npm install
npm run dev        # dev server with HMR (default http://localhost:5173)
```

Other commands:

```sh
npm run build      # production bundle -> dist/
npm run preview    # serve the production build locally
npm test           # Vitest unit tests for the simulation (no browser)
node scripts/smoke-test.mjs   # headless E2E check (see below)
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Aim (pointer lock) |
| Left mouse | Fire (SMG full auto; sniper semi-auto) |
| Right mouse | Iron sights (zoom + tighter spread) |
| `R` | Reload |
| `Shift` | Run (hold — 1.5× speed, ~0.2 s ramp) |
| `Ctrl` / `C` | Crouch (tap to toggle; slower, silent — no footsteps) |
| `Space` | Jump |
| `Esc` | Pause / release mouse |
| `V` | **Dev builds only** — bot debug view: wireframes the level, draws each bot's nav route and current target, and makes the player unkillable (`src/debugView.ts`). Stripped from production builds. |

## Gameplay

Before deploying you pick a **loadout**: one primary and one secondary from the weapon catalog (SMG / AK-47 / sniper / shotgun primaries; pistol / revolver secondaries). The picker opens at match start (after Play) and again on death, pre-filled with your last pick; Deploy commits it and enters the game. In-game, `1`/`2` switch between the two positions and `Q` quick-swaps. Your pick survives map switches via sessionStorage.

Five maps plus the match setup (the game mode, your side, enemy/allied bot counts, round length in minutes, the domination points-to-win, and each side's bot primary and secondary), chosen in the start menu. Changing anything commits it to the URL query (`?map=…&mode=…&side=…&tbots=…&ctbots=…&time=…&scorelimit=…&tweap=…&tsec=…&ctweap=…&ctsec=…`) and reloads the page:

**Bots carry real loadouts.** Each side sets a primary (SMG / AK-47 / sniper / shotgun) and a secondary (pistol / revolver), or **Mixed** (the default for both positions) to draw one per bot, and the choice drives everything downstream: its accuracy curve and falloff, how close it wants to fight, its rate of fire, its magazine and reload, its damage by hit zone — and its silhouette, its report, and the killfeed line it leaves. A sniper bot threatens across the whole map and a shotgun bot is harmless past ten metres, so what the enemy is holding is now worth reading off their barrel. When a position runs dry the bot swaps down the ladder — primary, then sidearm, then the blade every loadout carries.

- **Arena** (`src/maps/arena.ts`) — enemy bots (menu-configured count and weapon, default 6 and Mixed) spawn in the far half of the map and hunt you. They respect cover: they only shoot with clear line of sight.
- **Elevation** (`src/maps/elevation.ts`) — a playtest map for watching how the bots cope with height: a two-story building with an internal stairwell and an external flight, an unrailed bridge to a tower, a plateau, and a jump-only route no bot can ever take. Bots route over a navigation graph when a target is a level above them (`src/nav.ts`), so this is where you see how they find stairs, decks and drops — press `V` in a dev build to watch the routes themselves.
- **Warehouse (aisles)** (`src/maps/warehouse1.ts`) — a distribution warehouse built as an aisle grid: six racking rows with cross-aisles, a mezzanine office straddling the mid-line as the contested high ground, loading docks at both ends, and flank conveyors low enough for you to vault but too high for a bot to walk, so you get a mobility edge they can't answer.
- **Warehouse (vertical stack)** (`src/maps/warehouse2.ts`) — the same building turned on its side: an 8 m catwalk ring runs the full perimeter five metres up, and the whole 44 × 24 middle is cut away, so the ring looks down on the floor and the floor looks up at the ring. Two open stairs stand in the void (you can walk under them), two cargo lifts throw you onto the ring one-way, and the spawns are asymmetric — on CT-side you muster in the fenced yard and have to come through a doorway while the enemy starts holding the high ground; on T-side it is the reverse, and you start on the catwalk.
- **Shooting Range** (`src/maps/range.ts`) — a private lane with floor markers at 10–50 m and bot-silhouette targets (identical hitbox dimensions to real bots) wearing elliptical bullseye rings at 10–60 m. Nothing shoots back; `R` restores your full loadout without consuming reserve ammo. Use it to practice accuracy and recoil patterns.

Common rules:

- Damage zones: head ×2 with the SMG/pistol (two headshots to kill), ×4 with the sniper/shotgun/revolver (one-shot kill); torso ×1; legs ×0.75.
- Accuracy stacks: each weapon has an inherent rest cone, on top of which stance, movement and being airborne add spread, all multiplied by a spray factor that grows while you hold the trigger. Crouching is the most accurate stance and crouch-walking the most accurate way to move; sprinting is far worse than walking (movement scales cubically), and shooting mid-air is worse still. Recoil climbs vertically *and* wanders horizontally, so sustained fire has to be steered, not just pulled down.
- Bullets leave persistent decals (capped at 200; oldest recycled) — check your grouping on any surface.
- **Team deathmatch** (`?mode=tdm`, the default) ends two ways: when the clock runs out the higher kill score wins (ties draw), and wiping every enemy bot wins outright for your side — unless it's a 1v1, where the lone bot respawns and only the clock can end it.
- **Domination** (`?mode=dom`, currently Elevation only) is played on three capture points, each on its own level — C at grade down the tower lane, A up on the plateau crown, B on the building's second-floor deck. Stand inside a point's ring with no enemy in it for 8 seconds to take it; an enemy present freezes the capture, and leaving lets the progress bleed back. Every point you hold ticks 1 point per second, and the first side to the points-to-win (200 by default, 50–2000 in the menu) takes the match — otherwise the higher score at the clock does. **Kills score nothing** here, and wiping the enemy team wins nothing either: the dead redeploy on an equal share of every point their side owns plus their original spawn, so a team holding two flags still comes back home a third of the time and a team holding none always does. Bots play the objectives, so expect to be pushed off a point rather than hunted across the map.
- The end shows a score screen (winner, team scores, per-bot K/D) with Rematch / Back to Menu.
- Individual bots self-respawn 6 s after dying.
- Bots' accuracy degrades with distance.

## Architecture

Single-page app; all game code is ES modules under `src/`, bundled by Vite.

```
src/
├── core/
│   ├── state.ts  # ALL shared mutable state — pure, importable in Node
│   └── engine.ts # renderer/scene/camera/clock, built by initEngine()
├── sim/          # pure gameplay math, unit-tested in Node (no engine, no DOM)
│   ├── accuracy.ts   # spread model + crosshair gap projection
│   ├── recoil.ts     # view punch (pitch + yaw), recoil/spray decay
│   ├── ballistics.ts # shot direction (owns the YXZ Euler order)
│   ├── damage.ts     # hit zones and damage multipliers
│   ├── movement.ts   # speed tiers, measured movement input
│   ├── botBrains.ts  # bot decision policies (the BotBrain seam)
│   └── smoothing.ts  # frame-rate-aware easing shared by every 0..1 blend
├── maps/         # level geometry, one builder per map
│   ├── index.ts     # MapName -> builder registry; a new map must register here
│   ├── arena.ts     # de_dust-style arena (walls, buildings, crates)
│   ├── range.ts     # shooting range (lane, distance markers, silhouette targets)
│   ├── elevation.ts # bot testbed (two-story building, bridge, plateau)
│   ├── warehouse1.ts # aisle grid (racking rows, mezzanine, docks, conveyors)
│   ├── warehouse2.ts # vertical stack (catwalk ring over an open floor, lifts)
│   └── mockups/     # greybox references the maps were built from (not built)
├── main.ts       # entry point: init order, input, pointer lock/menus, game loop
├── world.ts      # solids/colliders registries — the ONE way to register geometry
├── collision.ts  # AABB movement collision + line-of-sight raycast (pure)
├── player.ts     # FPS controller: move/crouch/footsteps/camera
├── weapons.ts    # per-weapon viewmodels, firing (incl. shotgun pellets), reload, ADS/recoil/spread
├── bots.ts       # Bot executor: realizes what its brain decides
├── combat.ts     # damage resolution, respawn, match end
├── effects.ts    # transient visuals (bullet impacts)
├── audio.ts      # WebAudio-synthesized SFX (no assets)
├── menu.ts       # start / pause / loadout-picker / score-screen overlays and the match-config form
└── hud.ts        # DOM overlay (health/ammo/score/kill feed)
```

Key design points:

- **`core/state.js` owns shared state.** Player, weapon, and transient flags are plain exported objects that modules mutate directly. Dependencies flow one way (`core` ← everything); there are no import cycles.
- **State is separated from the engine so the simulation is testable.** `core/state.js` touches no browser API, so it imports in plain Node; `core/engine.js` holds the renderer/scene/camera and is built by `initEngine()`. Modules that need the engine or the DOM expose an `init*()` function called in order from `main.js` rather than wiring themselves up on import.
- **Gameplay math is pure and lives in `src/sim/`.** Spread, recoil, shot direction, damage zones and speed tiers take every input as a parameter, so they are unit-tested in milliseconds without a browser. `weapons.js` and `player.js` are thin bindings that feed live state in.
- **The frame's stage order is explicit in `main.js:animate()`** — `updateMovement → updateWeapon → updateCamera → updateViewmodel` — because it is load-bearing: the camera and viewmodel read the recoil that `updateWeapon` decays, so the crosshair and the bullets agree within a frame.
- **Two collision registries, one registration path.** Every level solid is registered as an AABB in `colliders` (cheap per-frame movement tests) and as a mesh in `solids` (raycast targets for bullets and bot LOS). Both live in `src/world.ts`, which is the only place geometry may be registered — the map builders in `src/maps/` once carried separate copies of that logic, and the range copy shipped without the `colliders` push, making the whole map no-clip.
- **Hitscan bullets resolve by nearest hit** across walls *and* bot body parts in a single raycast, so cover always blocks damage — for both sides.
- **No build-time safety net for missing imports** referenced only inside functions (Vite won't catch it) — see AGENTS.md.

## Smoke test

With the dev server running in another terminal:

```sh
node scripts/smoke-test.mjs
```

Launches your Brave browser headlessly (via puppeteer-core), loads the page, captures console errors, simulates pressing `R`, and verifies the reload completes. The Brave executable path inside the script is machine-specific (Flatpak install path) — adjust if yours differs.

## Debug hook

While playing, live game state is exposed on the console as `window.__cs` (`{ game, weapon, player, bots }`) for quick inspection.

## License

[MIT](LICENSE) © Thomas Nguyen. The code, the procedural visuals and the
Blender weapon sources in `assets/` are all original work; no Counter-Strike
assets are used or redistributed.
