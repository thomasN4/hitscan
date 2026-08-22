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
node scripts/smoke-test.mjs   # headless E2E check (see below)
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Aim (pointer lock) |
| Left mouse | Fire (full auto) |
| Right mouse | Iron sights (zoom + tighter spread) |
| `R` | Reload |
| `Shift` | Crouch (slower, silent — no footsteps) |
| `Space` | Jump |
| `Esc` | Pause / release mouse |

## Gameplay

Two maps, chosen from the start menu (switching reloads the page with `?map=range`):

- **Arena** (`src/map.js`) — 6 enemy bots spawn in the far half of the map and hunt you. They respect cover: they only shoot with clear line of sight.
- **Shooting Range** (`src/range.js`) — a private lane with floor markers at 10–50 m and bot-silhouette targets (identical hitbox dimensions to real bots) wearing elliptical bullseye rings at 10–60 m. Nothing shoots back; `R` restores your full loadout without consuming reserve ammo. Use it to practice accuracy and recoil patterns.

Common rules:

- Damage zones: head ×4 (one-shot kill), torso ×1, legs ×0.75.
- Bullets leave persistent decals (capped at 200; oldest recycled) — check your grouping on any surface.
- Clearing all bots simultaneously wins the round; individual bots self-respawn after 6 s.
- Bots' accuracy degrades with distance.

## Architecture

Single-page app; all game code is ES modules under `src/`, bundled by Vite.

```
src/
├── core.js       # engine singletons + ALL shared mutable state
├── main.js       # entry point: input, pointer lock/menus, game loop
├── map.js        # arena geometry (walls, buildings, crates)
├── collision.js  # AABB movement collision + line-of-sight raycast
├── player.js     # FPS controller: move/crouch/footsteps/camera
├── weapons.js    # rifle viewmodel, firing, reload, ADS/recoil/spread
├── bots.js       # Bot class and AI decision loop
├── combat.js     # damage resolution, respawn, round end
├── effects.js    # transient visuals (bullet impacts)
├── audio.js      # WebAudio-synthesized SFX (no assets)
└── hud.js        # DOM overlay (health/ammo/score/kill feed)
```

Key design points:

- **`core.js` owns shared state.** Player, weapon, and transient flags are plain exported objects that modules mutate directly. Dependencies flow one way (`core` ← everything); there are no import cycles.
- **Two collision registries.** Every level solid is registered as an AABB in `colliders` (cheap per-frame movement tests) and as a mesh in `solids` (raycast targets for bullets and bot LOS). Add geometry through `map.addBox` so both stay consistent.
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
