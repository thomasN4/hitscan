# Counter-Strike Clone Demo

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

## Gameplay

Two maps, chosen from the start menu (switching reloads the page with `?map=range`):

- **Arena** (`src/map.js`) — 6 enemy bots spawn in the far half of the map and hunt you. They respect cover: they only shoot with clear line of sight.
- **Shooting Range** (`src/range.js`) — a private lane with floor markers at 10–50 m and bot-silhouette targets (identical hitbox dimensions to real bots) wearing elliptical bullseye rings at 10–60 m. Nothing shoots back; `R` restores your full loadout without consuming reserve ammo. Use it to practice accuracy and recoil patterns.

Common rules:

- Damage zones: head ×4 (one-shot kill), torso ×1, legs ×0.75.
- Accuracy stacks: each weapon has an inherent rest cone, on top of which stance, movement and being airborne add spread, all multiplied by a spray factor that grows while you hold the trigger. Crouching is the most accurate stance and crouch-walking the most accurate way to move; sprinting is far worse than walking (movement scales cubically), and shooting mid-air is worse still. Recoil climbs vertically *and* wanders horizontally, so sustained fire has to be steered, not just pulled down.
- Bullets leave persistent decals (capped at 200; oldest recycled) — check your grouping on any surface.
- Clearing all bots simultaneously wins the round; individual bots self-respawn after 6 s.
- Bots' accuracy degrades with distance.

## Architecture

Single-page app; all game code is ES modules under `src/`, bundled by Vite.

```
src/
├── core/
│   ├── state.js  # ALL shared mutable state — pure, importable in Node
│   └── engine.js # renderer/scene/camera/clock, built by initEngine()
├── sim/          # pure gameplay math, unit-tested in Node (no engine, no DOM)
│   ├── accuracy.js   # spread model + crosshair gap projection
│   ├── recoil.js     # view punch (pitch + yaw), recoil/spray decay
│   ├── ballistics.js # shot direction (owns the YXZ Euler order)
│   ├── damage.js     # hit zones and damage multipliers
│   ├── movement.js   # speed tiers, measured movement input
│   └── smoothing.js  # frame-rate-aware easing shared by every 0..1 blend
├── main.js       # entry point: init order, input, pointer lock/menus, game loop
├── map.js        # arena geometry (walls, buildings, crates)
├── world.js      # solids/colliders registries — the ONE way to register geometry
├── collision.js  # AABB movement collision + line-of-sight raycast (pure)
├── player.js     # FPS controller: move/crouch/footsteps/camera
├── weapons.js    # smg/sniper viewmodels, firing, reload, ADS/recoil/spread
├── bots.js       # Bot class and AI decision loop
├── combat.js     # damage resolution, respawn, round end
├── effects.js    # transient visuals (bullet impacts)
├── audio.js      # WebAudio-synthesized SFX (no assets)
└── hud.js        # DOM overlay (health/ammo/score/kill feed)
```

Key design points:

- **`core/state.js` owns shared state.** Player, weapon, and transient flags are plain exported objects that modules mutate directly. Dependencies flow one way (`core` ← everything); there are no import cycles.
- **State is separated from the engine so the simulation is testable.** `core/state.js` touches no browser API, so it imports in plain Node; `core/engine.js` holds the renderer/scene/camera and is built by `initEngine()`. Modules that need the engine or the DOM expose an `init*()` function called in order from `main.js` rather than wiring themselves up on import.
- **Gameplay math is pure and lives in `src/sim/`.** Spread, recoil, shot direction, damage zones and speed tiers take every input as a parameter, so they are unit-tested in milliseconds without a browser. `weapons.js` and `player.js` are thin bindings that feed live state in.
- **The frame's stage order is explicit in `main.js:animate()`** — `updateMovement → updateWeapon → updateCamera → updateViewmodel` — because it is load-bearing: the camera and viewmodel read the recoil that `updateWeapon` decays, so the crosshair and the bullets agree within a frame.
- **Two collision registries, one registration path.** Every level solid is registered as an AABB in `colliders` (cheap per-frame movement tests) and as a mesh in `solids` (raycast targets for bullets and bot LOS). Both live in `src/world.js`, which is the only place geometry may be registered — `map.js` and `range.js` once carried separate copies of that logic, and the range copy shipped without the `colliders` push, making the whole map no-clip.
- **Hitscan bullets resolve by nearest hit** across walls *and* bot body parts in a single raycast, so cover always blocks damage — for both sides.
- **No build-time safety net for missing imports** referenced only inside functions (Vite won't catch it) — see AGENTS.md.

## Smoke test

With the dev server running in another terminal:

```sh
node scripts/smoke-test.mjs
```

Launches your Brave browser headlessly (via puppeteer-core), loads the page, captures console errors, simulates pressing `R`, and verifies the reload completes. The Brave executable path inside the script is machine-specific (Flatpak install path) — adjust if yours differs.

## Debug hook

While playing, live game state is exposed on the console as `window.__cs` (`{ game, weapon, player }`) for quick inspection.
