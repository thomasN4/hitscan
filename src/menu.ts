// menu.ts — DOM for the pre-game match-config menu, the loadout picker, the
// pause overlay and the match-end score screen.
//
// Split out of main.ts alongside hud.ts's ownership rule: hud.ts writes the
// in-game HUD, this module writes everything inside #startMenu / #pauseMenu /
// #loadoutScreen / #endScreen.
// Like hud.ts it grabs references through an init*() function called once by
// main.ts (after the session config has been parsed into core/state), and a
// missing id is a named startup error via hud.ts:requireEl.
//
// Commit model: match settings ride ONE query string (?map=&tbots=&ctbots=&time=).
// Play compares the form against the applied session config — equal means the
// page already matches, so it opens the loadout picker; different means
// navigate-and-reload (map switching is a full reload, and pointer lock needs
// a fresh gesture on the new page anyway). The picker is shared by BOTH entry
// points: match start (after Play) and death (replacing the old plain death
// screen), pre-filled with lastLoadout either way. Its Deploy click doubles as
// the user gesture pointer lock requires — see main.ts's onDeploy handler.
import type { LoadoutState, MapName, WeaponClass, WeaponId } from './core/state';
import { bots, score, WEAPONS, lastLoadout, sanitizeLoadout, session } from './core/state';
import type { MatchWinner } from './sim/match';
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
  arena: 'Eliminate all Ts to win the round',
  range: 'Practice your aim \u2014 silhouettes with bullseyes at 10\u201360 m',
  elevation: 'Bot testbed \u2014 stairs, decks and drops: watch how the AI handles height',
  warehouse1: 'Racking aisles, a contested mezzanine, and conveyors only you can vault',
  warehouse2: 'A catwalk ring over an open floor \u2014 stairs, cargo lifts, and nowhere to hide from above',
};

/** What the menu does on Play/Resume/Quit/Deploy — main.ts supplies the behaviors. */
export interface MenuHandlers {
  /** Form matches the applied session config: open the loadout picker. */
  onStart(): void;
  /** Form differs: navigate to the committed query string (full reload). */
  onCommit(query: string): void;
  /** Pause menu Resume: enter pointer lock. */
  onResume(): void;
  /** Pause menu Quit to Menu: reload so the scene rebuilds fresh. */
  onQuit(): void;
  /** End screen Rematch: reload with the same committed config query. */
  onRematch(): void;
  /** End screen Back to Menu: navigate to the bare path (default config). */
  onExitToMenu(): void;
  /** Picker Deploy: apply the picked loadout (respawning if dead) and enter play. */
  onDeploy(primary: WeaponId, secondary: WeaponId): void;
}

// Resolved by initMenus(); non-optional like hud.ts's refs — "read only after
// init" is the documented contract.
let startMenu: HTMLElement, pauseMenu: HTMLElement, loadoutScreen: HTMLElement, endScreen: HTMLElement,
  subtitleEl: HTMLElement, loadoutTitle: HTMLElement, loadoutMsg: HTMLElement,
  colPrimary: HTMLElement, colSecondary: HTMLElement,
  endTitle: HTMLElement, endScoreCT: HTMLElement, endScoreT: HTMLElement, scoreboardBody: HTMLElement;
let deployBtn: HTMLButtonElement;
let mapSel: HTMLSelectElement, botsTIn: HTMLInputElement, botsCtIn: HTMLInputElement,
  timeMinIn: HTMLInputElement;

// ---------- Loadout picker state ----------
// Both columns always hold a valid selection (pre-filled from lastLoadout);
// keyboard focus just moves which one the arrows control. The knife has no
// column — it is always carried (key 3), never picked — so the picker's
// types cover only the two positions a deploy actually sets.
type PickedClass = Exclude<WeaponClass, 'melee'>;
interface CardRefs {
  id: WeaponId;
  el: HTMLButtonElement;
}
const cards: Record<PickedClass, CardRefs[]> = { primary: [], secondary: [] };
let sel: LoadoutState = { ...lastLoadout };
let focusCol: PickedClass = 'primary';

/**
 * Persisted last-deployed loadout (sessionStorage): survives map switches and
 * quit-to-menu page reloads so the next picker opens where you left off.
 * Storage IO lives here because state.ts must stay importable in Node —
 * sanitizeLoadout() there owns deciding what may be applied.
 */
const LOADOUT_KEY = 'acsc.loadout';

export function saveLoadout(l: LoadoutState): void {
  try { sessionStorage.setItem(LOADOUT_KEY, JSON.stringify(l)); } catch { /* storage unavailable */ }
}

export function readStoredLoadout(): LoadoutState | undefined {
  try {
    const raw = sessionStorage.getItem(LOADOUT_KEY);
    if (raw === null) return undefined;
    return sanitizeLoadout(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function refreshPickerUi(): void {
  for (const cls of ['primary', 'secondary'] as const) {
    for (const c of cards[cls]) c.el.classList.toggle('selected', sel[cls] === c.id);
  }
  colPrimary.classList.toggle('focused', focusCol === 'primary');
  colSecondary.classList.toggle('focused', focusCol === 'secondary');
}

function moveFocus(delta: number): void {
  const list = cards[focusCol];
  const idx = list.findIndex(c => c.id === sel[focusCol]);
  // findIndex above cannot miss: sel is only ever assigned ids that built a card.
  const next = list[(idx + delta + list.length) % list.length]!;
  sel[focusCol] = next.id;
  refreshPickerUi();
}

/**
 * Open the shared picker. Mode only changes copy/styling — both entries are
 * the same deploy flow. Pre-fills from lastLoadout every time.
 */
export function showLoadoutPicker(mode: 'start' | 'death'): void {
  loadoutTitle.textContent = mode === 'death' ? 'You Died' : 'Choose your loadout';
  loadoutTitle.classList.toggle('died', mode === 'death');
  loadoutMsg.style.display = mode === 'death' ? 'block' : 'none';
  sel = { primary: lastLoadout.primary, secondary: lastLoadout.secondary };
  focusCol = 'primary';
  refreshPickerUi();
  loadoutScreen.style.display = 'flex';
}

/**
 * Reveal the match-end score screen. Called once per match by combat.ts's
 * endMatch (on its wall-clock delay), so the table is rebuilt every time
 * from the final counters — a static snapshot; nothing simulates behind it.
 * Rows: You first among equals, everyone sorted by kills descending.
 */
export function showEndScreen(winner: MatchWinner): void {
  const banner: Record<MatchWinner, string> = {
    CT: 'Counter-Terrorists Win',
    T: 'Terrorists Win',
    draw: 'Draw',
  };
  endTitle.textContent = banner[winner];
  // Color the banner like the winning side; a draw gets a neutral tone.
  endTitle.classList.toggle('ct', winner === 'CT');
  endTitle.classList.toggle('t', winner === 'T');
  endTitle.classList.toggle('draw', winner === 'draw');
  endScoreCT.textContent = 'CT ' + score.scoreKills;
  endScoreT.textContent = score.scoreDeaths + ' T';

  interface Row { name: string; team: 'T' | 'CT'; kills: number; deaths: number; you: boolean }
  const rows: Row[] = [
    { name: 'You', team: 'CT', kills: score.playerKills, deaths: score.playerDeaths, you: true },
    ...bots.map(b => ({ name: b.name, team: b.team, kills: b.kills, deaths: b.deaths, you: false })),
  ];
  // Explicit you-first tie-break: ES2019 sorts are stable, but the documented
  // "You first among equals" should not ride on insertion order.
  rows.sort((a, b) => b.kills - a.kills || (a.you ? -1 : b.you ? 1 : 0));

  scoreboardBody.replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr');
    if (r.you) tr.className = 'you';
    const nameTd = document.createElement('td');
    nameTd.className = 'name ' + r.team.toLowerCase();
    nameTd.textContent = r.name;
    const kTd = document.createElement('td');
    kTd.textContent = String(r.kills);
    const dTd = document.createElement('td');
    dTd.textContent = String(r.deaths);
    tr.append(nameTd, kTd, dTd);
    return tr;
  }));

  endScreen.style.display = 'flex';
}

function buildCards(): void {
  for (const [id, def] of Object.entries(WEAPONS)) {
    // Melee defs build no card: the knife is carried always and picked never
    // (the hint below the Deploy button says so). Skipping here is what keeps
    // it out of the secondary column, where the non-primary branch would
    // otherwise drop it.
    if (def.class === 'melee') continue;
    // Object.entries widens to string; the card click handler narrows via a
    // catalog lookup instead of trusting the attribute. The class is captured
    // narrowed here because a closure cannot see control-flow narrowing of a
    // property read.
    const cls: PickedClass = def.class;
    const el = document.createElement('button');
    el.className = 'wcard';
    const dps = def.pellets !== undefined ? `${def.damage}\u00d7${def.pellets}` : String(def.damage);
    el.innerHTML =
      `<span class="wname">${def.name}</span>` +
      `<span class="wstats">${dps} dmg \u00b7 ${(1 / def.fireRate).toFixed(1)}/s \u00b7 ${def.magSize} rounds</span>`;
    el.onclick = () => {
      sel[cls] = id as WeaponId;
      focusCol = cls;
      refreshPickerUi();
    };
    (cls === 'primary' ? colPrimary : colSecondary).appendChild(el);
    cards[cls].push({ id: id as WeaponId, el });
  }
}

/**
 * Resolve every menu element + build the picker cards, initialize the form
 * from the applied session config, and wire Play/Resume/Quit/Deploy. Call
 * once at startup, AFTER main.ts has written the parsed config into `session`.
 */
export function initMenus(handlers: MenuHandlers): void {
  startMenu = requireEl('startMenu');
  pauseMenu = requireEl('pauseMenu');
  loadoutScreen = requireEl('loadoutScreen');
  endScreen = requireEl('endScreen');
  subtitleEl = requireEl('menuSubtitle');
  loadoutTitle = requireEl('loadoutTitle');
  loadoutMsg = requireEl('loadoutMsg');
  colPrimary = requireEl('colPrimary');
  colSecondary = requireEl('colSecondary');
  deployBtn = requireEl('deployBtn') as HTMLButtonElement;
  endTitle = requireEl('endTitle');
  endScoreCT = requireEl('endScoreCT');
  endScoreT = requireEl('endScoreT');
  scoreboardBody = requireEl('scoreboardBody');
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
  buildCards();

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
  requireEl('rematchBtn').onclick = () => handlers.onRematch();
  requireEl('endMenuBtn').onclick = () => handlers.onExitToMenu();

  const deploy = (): void => {
    saveLoadout(sel);
    handlers.onDeploy(sel.primary, sel.secondary);
  };
  deployBtn.onclick = deploy;

  // Picker keyboard support, active only while the picker is visible. The
  // game's own key handlers stay inert behind it: switchWeapon/tryReload gate
  // on started/alive, which are false (match start) or alive === false (death)
  // whenever this screen shows.
  addEventListener('keydown', e => {
    if (loadoutScreen.style.display !== 'flex') return;
    if (e.code === 'ArrowUp') moveFocus(-1);
    else if (e.code === 'ArrowDown') moveFocus(1);
    else if (e.code === 'ArrowLeft') focusCol = 'primary';
    else if (e.code === 'ArrowRight') focusCol = 'secondary';
    else if (e.code === 'Enter') deploy();
    else return;
    e.preventDefault();
    refreshPickerUi();
  });
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
  loadoutScreen.style.display = 'none';
  endScreen.style.display = 'none';
}

export function showPauseMenu(show: boolean): void {
  pauseMenu.style.display = show ? 'flex' : 'none';
}
