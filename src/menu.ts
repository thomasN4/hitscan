// menu.ts — DOM for the pre-game match-config menu and the pause/death overlays.
//
// Split out of main.ts alongside hud.ts's ownership rule: hud.ts writes the
// in-game HUD, this module writes everything inside #startMenu / #pauseMenu /
// #deathScreen.
// Like hud.ts it grabs references through an init*() function called once by
// main.ts (after the session config has been parsed into core/state), and a
// missing id is a named startup error via hud.ts:requireEl.
//
// Commit model: settings ride ONE query string (?map=&tbots=&ctbots=&time=).
// Play compares the form against the applied session config — equal means the
// page already matches, so it enters pointer lock directly; different means
// navigate-and-reload (map switching is a full reload, and pointer lock needs
// a fresh gesture on the new page anyway). That makes a changed setting cost
// two clicks total (commit, then Play) and a fresh load exactly one.
import type { MapName } from './core/state';
import { session } from './core/state';
import {
  BOTS_CT_LIMITS,
  BOTS_T_LIMITS,
  TIME_LIMITS_S,
  asMapName,
  clampTo,
  configsEqual,
  configToQuery,
  numOr,
  secondsToMinutesLabel,
  type SessionConfig,
} from './core/sessionConfig';
import { requireEl } from './hud';

const SUBTITLES: Record<MapName, string> = {
  arena: 'Clone Demo \u2014 eliminate all Ts to win the round',
  range: 'Practice your aim \u2014 silhouettes with bullseyes at 10\u201360 m',
  elevation: 'Bot testbed \u2014 stairs, decks and drops: watch how the AI handles height',
};

/** What the menu does on Play/Resume/Quit — main.ts supplies the behaviors. */
export interface MenuHandlers {
  /** Form matches the applied session config: enter pointer lock. */
  onStart(): void;
  /** Form differs: navigate to the committed query string (full reload). */
  onCommit(query: string): void;
  /** Pause menu Resume: enter pointer lock. */
  onResume(): void;
  /** Pause menu Quit to Menu: reload so the scene rebuilds fresh. */
  onQuit(): void;
  /** Death screen Respawn button: hide the screen, respawn, re-lock. */
  onRespawn(): void;
}

// Resolved by initMenus(); non-optional like hud.ts's refs — "read only after
// init" is the documented contract.
let startMenu: HTMLElement, pauseMenu: HTMLElement, deathScreen: HTMLElement, subtitleEl: HTMLElement;
let mapSel: HTMLSelectElement, botsTIn: HTMLInputElement, botsCtIn: HTMLInputElement,
  timeMinIn: HTMLInputElement;

/**
 * Resolve every menu element, initialize the form from the applied session
 * config, and wire Play/Resume/Quit/Respawn. Call once at startup, AFTER
 * main.ts has written the parsed config into `session`.
 */
export function initMenus(handlers: MenuHandlers): void {
  startMenu = requireEl('startMenu');
  pauseMenu = requireEl('pauseMenu');
  deathScreen = requireEl('deathScreen');
  subtitleEl = requireEl('menuSubtitle');
  mapSel = requireEl('cfgMap') as HTMLSelectElement;
  botsTIn = requireEl('cfgBotsT') as HTMLInputElement;
  botsCtIn = requireEl('cfgBotsCt') as HTMLInputElement;
  timeMinIn = requireEl('cfgTimeMin') as HTMLInputElement;

  mapSel.value = session.map;
  botsTIn.value = String(session.botsT);
  botsCtIn.value = String(session.botsCt);
  timeMinIn.value = secondsToMinutesLabel(session.roundSeconds);
  applyMapUi();

  mapSel.onchange = applyMapUi;

  requireEl('playBtn').onclick = () => {
    const candidate = candidateConfig();
    if (configsEqual(candidate, appliedConfig())) {
      handlers.onStart();
    } else {
      handlers.onCommit(configToQuery(candidate));
    }
  };
  requireEl('resumeBtn').onclick = () => handlers.onResume();
  requireEl('quitBtn').onclick = () => handlers.onQuit();
  requireEl('respawnBtn').onclick = () => handlers.onRespawn();
}

/** Range matches have no bots and no clock: gray those rows out live. */
function applyMapUi(): void {
  const isRange = mapSel.value === 'range';
  subtitleEl.textContent = SUBTITLES[asMapName(mapSel.value)];
  botsTIn.disabled = isRange;
  botsCtIn.disabled = isRange;
  timeMinIn.disabled = isRange;
}

/** Field-by-field view of what the page was loaded with. */
function appliedConfig(): SessionConfig {
  return { map: session.map, botsT: session.botsT, botsCt: session.botsCt, roundSeconds: session.roundSeconds };
}

/** Form contents as a SessionConfig, clamped exactly like the URL parser. */
function candidateConfig(): SessionConfig {
  return {
    map: asMapName(mapSel.value),
    // A cleared/garbage field keeps the currently-applied value rather than
    // forcing a retype; Number('') is 0, so emptiness must be checked first.
    botsT: Math.round(clampTo(numOr(botsTIn.value, session.botsT), BOTS_T_LIMITS)),
    botsCt: Math.round(clampTo(numOr(botsCtIn.value, session.botsCt), BOTS_CT_LIMITS)),
    roundSeconds: Math.round(
      clampTo(numOr(timeMinIn.value, session.roundSeconds / 60) * 60, TIME_LIMITS_S),
    ),
  };
}

// ---------- Visibility toggles (called from main.ts's pointerlockchange) ----------

export function hideAllMenus(): void {
  startMenu.style.display = 'none';
  pauseMenu.style.display = 'none';
}

export function showPauseMenu(show: boolean): void {
  pauseMenu.style.display = show ? 'flex' : 'none';
}

export function showDeathScreen(show: boolean): void {
  deathScreen.style.display = show ? 'flex' : 'none';
}
