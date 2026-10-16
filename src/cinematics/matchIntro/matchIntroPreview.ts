import { MatchIntroCinematic } from "./MatchIntroCinematic";
import { createGameIntroCharacterFactory } from "./gameCharacterFactory";
import { playMatchIntroCueSound, preloadMatchIntroSounds } from "./matchIntroSounds";
import { MAX_INTRO_PLAYERS, type MatchIntroCue, type MatchIntroPlayer } from "./MatchIntroTypes";
import { FULL_ASTRONAUT_SELECTION } from "../../cosmetics/astronaut/AstronautRuntime";
import { audio } from "../../audio/AudioManager";

/**
 * MATCH INTRO — dev preview page (not part of the game bundle).
 *
 *   npm run dev  →  http://localhost:5173/intro-preview.html
 *
 *   ?n=2..8      number of players (default 8)
 *   ?t=6.4       freeze one instant (scrub a frame)
 *   ?map=GIVRE   map name on the opening title
 *   ?loop        replay automatically
 *   ?capture     frame-by-frame capture: exposes window.__matchIntro.renderAt(t)
 *   ?quality=high|medium|low   force the 3D quality (default: auto)
 *
 * Keys (outside playback): R or Enter = replay, 2…8 = player count.
 * During playback: Space / Escape / click = skip. Sound starts after the
 * first click / key press (browser autoplay rule).
 */

const MOCK_PLAYERS: MatchIntroPlayer[] = [
  { id: "p1", name: "Sneus", level: 27, kd: 2.41, kills: 1204, wins: 61, isLocal: true, cosmetics: FULL_ASTRONAUT_SELECTION },
  { id: "p2", name: "Patator", level: 14, kd: 1.12 },
  { id: "p3", name: "Frite_Master", level: 31, kd: 1.38, cosmetics: { hats: "astronaut_helmet" } },
  { id: "p4", name: "BeanieBoy", level: 6, kd: 0.64 },
  { id: "p5", name: "Gratin42", level: 19, kd: 0.97, cosmetics: { tops: "astronaut_top", bags: "astronaut_backpack" } },
  { id: "p6", name: "TuberGang", level: 22, kd: 1.71 },
  { id: "p7", name: "PureePower", level: 9, kd: 0.81, cosmetics: { pants: "astronaut_pants", shoes: "astronaut_shoes" } },
  { id: "p8", name: "Kartofel", level: 40, kd: 1.55 },
];

interface CaptureApi {
  renderAt(t: number): boolean;
  end: number;
  fps: number;
  /** The live instance (dev tooling / profiling only). */
  intro: unknown;
}
declare global {
  interface Window {
    __matchIntro?: CaptureApi;
  }
}

const query = new URLSearchParams(location.search);
const clampCount = (v: number): number => Math.max(2, Math.min(MAX_INTRO_PLAYERS, Math.round(v) || MAX_INTRO_PLAYERS));
let count = clampCount(Number(query.get("n") ?? MAX_INTRO_PLAYERS));
const freezeAt = query.has("t") ? Number(query.get("t")) : null;
const capture = query.has("capture");
const mapName = query.get("map") ?? "GIVRE";
const loop = query.has("loop");
const qualityParam = query.get("quality");
const quality = qualityParam === "high" || qualityParam === "medium" || qualityParam === "low" ? qualityParam : "auto";

const factory = createGameIntroCharacterFactory();
const panel = document.getElementById("intro-preview-panel");
const statusEl = document.getElementById("intro-preview-status");
const countEl = document.getElementById("intro-preview-count") as HTMLSelectElement | null;
const replayEl = document.getElementById("intro-preview-replay") as HTMLButtonElement | null;
const cueLog = document.getElementById("intro-preview-cues");

let current: MatchIntroCinematic | null = null;
let busy = false;
// Capture mode: the exit wipe reveals a clean backdrop (no dev panel).
if (capture) {
  if (panel) panel.style.display = "none";
  if (cueLog) cueLog.style.display = "none";
}
const sounds = preloadMatchIntroSounds().catch(() => undefined);

// Browser autoplay rule: the AudioContext may only start from a gesture.
const unlockAudio = (): void => audio.unlock();
window.addEventListener("pointerdown", unlockAudio, true);
window.addEventListener("keydown", unlockAudio, true);

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function onCue(cue: MatchIntroCue, t0: number): void {
  playMatchIntroCueSound(cue);
  const dt = ((performance.now() - t0) / 1000).toFixed(2);
  const who = "playerId" in cue ? ` ${cue.playerId}` : "";
  console.debug(`[match-intro] ${dt}s ${cue.type}${who}`);
  if (!cueLog) return;
  const li = document.createElement("li");
  li.textContent = `${dt}s · ${cue.type}${who}`;
  cueLog.appendChild(li);
}

async function run(): Promise<void> {
  if (busy) return;
  busy = true;
  current?.dispose();
  current = null;
  if (cueLog) cueLog.textContent = "";
  setStatus("Chargement des personnages…");
  panel?.classList.add("is-busy");
  const players = MOCK_PLAYERS.slice(0, count);
  let t0 = performance.now();
  const intro = new MatchIntroCinematic(players, factory, {
    mapName,
    quality,
    onCue: (cue) => onCue(cue, t0),
  });
  current = intro;
  const keepOnScreen = capture || freezeAt !== null;
  let replayLater = false;
  try {
    await Promise.all([intro.load(), sounds]);
    if (capture) {
      window.__matchIntro = {
        renderAt: (t: number) => intro.renderAt(t).done,
        end: intro.schedule.end,
        fps: 30,
        intro,
      };
      setStatus("Mode capture prêt.");
      return;
    }
    if (freezeAt !== null && Number.isFinite(freezeAt)) {
      intro.renderAt(freezeAt);
      setStatus(`Image figée à t = ${freezeAt.toFixed(2)} s`);
      return;
    }
    t0 = performance.now();
    const { skipped } = await intro.play();
    setStatus(skipped ? "Intro passée." : "Intro terminée.");
    replayLater = loop;
  } catch (err) {
    console.error("Match intro preview failed", err);
    setStatus("Échec — voir la console.");
  } finally {
    if (!keepOnScreen) {
      intro.dispose();
      if (current === intro) current = null;
    }
    panel?.classList.remove("is-busy");
    busy = false;
  }
  if (replayLater) window.setTimeout(() => void run(), 900);
}

if (countEl) {
  countEl.value = String(count);
  countEl.addEventListener("change", () => {
    count = clampCount(Number(countEl.value));
    void run();
  });
}
replayEl?.addEventListener("click", () => void run());
window.addEventListener("keydown", (e) => {
  if (busy || e.repeat) return;
  if (e.code === "KeyR" || e.code === "Enter") {
    e.preventDefault();
    void run();
  } else if (/^Digit[2-8]$/.test(e.code)) {
    count = clampCount(Number(e.code.slice(5)));
    if (countEl) countEl.value = String(count);
    void run();
  }
});

void run();
