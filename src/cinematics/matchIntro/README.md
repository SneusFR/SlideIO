# Match intro — "Versus arcade" player presentation

Start-of-match cinematic (~12 s for 8 players): every player is presented one
by one, weakest first, in slanted comic blades that fill the screen; the best
player (MVP) comes last with a close-up, then takes the big left panel. Names,
level and K/D (plus kills / wins for the MVP when provided) slam in as
stickers in the HUD style. Real 3D characters with their equipped outfit.

## Use it

```ts
import { playMatchIntro } from "./cinematics/matchIntro/MatchIntroCinematic";
import { createGameIntroCharacterFactory } from "./cinematics/matchIntro/gameCharacterFactory";
import { playMatchIntroCueSound, preloadMatchIntroSounds } from "./cinematics/matchIntro/matchIntroSounds";

void preloadMatchIntroSounds(); // once, early (keys shared with GameAudio)

// when every player of the match is known and the map is loaded:
const { skipped } = await playMatchIntro(players, createGameIntroCharacterFactory(), {
  mapName: "GIVRE",
  onCue: playMatchIntroCueSound, // or your own handler (see cues below)
});
// → start the countdown / give the controls back
```

`players: MatchIntroPlayer[]` (see `MatchIntroTypes.ts`):

| field | |
|---|---|
| `id`, `name` | session id + display name |
| `level`, `kd` | shown on every player |
| `kills?`, `wins?` | extra pills on the MVP only |
| `cosmetics?` | `CharacterCosmeticsSelection` (same contract as the avatars) |
| `isLocal?` | adds the green "TOI" tag |
| `score?` | optional ranking override (default `kd × 10 + level × 0.4`) |

Max 8 players (extra ones are dropped, lowest scores first). Every client
computes the same order from the same data.

## Behaviour

- Own WebGL renderer + full-screen layer (`z-index` 9000): the game renderer,
  camera and HUD are never touched. The host should simply not process
  gameplay input while it plays (or start the match after it resolves).
- `load()` builds the dressed clones in parallel and warms every shader up
  behind a hidden layer; `play()` resolves at the end of the exit wipe;
  `playMatchIntro()` does both and always disposes everything.
- Skippable by default: Space / Escape / Enter / click jumps to the exit wipe
  (skipped beats emit no cue). `skippable: false` to force it.
- Deterministic: `renderAt(t)` draws any instant (scrubbing, tests).
- Drawing buffer capped to ≈ 1920 × 1200 pixels; `pixelRatioCap` lowers it
  further. `quality: "auto"` (default) times the heaviest frame at load and
  lowers the 3D stage resolution / MSAA on slower GPUs (`"high" | "medium" |
  "low"` to force it).
- Performance: stages hidden behind a full-screen blade are skipped, settled
  tiles keep a cached render refreshed round-robin, the stage target is 8-bit
  (tone mapped in the materials). Measured at 1920 × 1080 on an Intel Iris Xe:
  ~58–60 fps in high quality (4× MSAA).

## Timing (s)

| players | per challenger | MVP | VS | end |
|---|---|---|---|---|
| 8 | 0.94 | 7.20 | 10.20 | 12.0 |
| 6 | 1.32 | 7.20 | 10.20 | 12.0 |
| 4 | 1.50 | 5.12 | 8.12 | 9.9 |
| 2 | 1.50 | 2.12 | 5.12 | 6.9 |

Cues (`onCue`): `open`, then per challenger `slash` → `reveal` (name slam) →
`slot`, then `mvpCrack` → `mvpReveal`, `vs`, `exit`, `end { skipped }`.

## Preview

`npm run dev` → `http://localhost:5173/intro-preview.html` (mock players, dev
only — not in the build). `?n=2..8`, `?t=6.4` (frozen frame), `?loop`,
`?map=GIVRE`, `?quality=high|medium|low`, `?capture` (exposes
`window.__matchIntro.renderAt(t)` for frame-by-frame capture). Keys: R replay,
2–8 player count.

## Files

| file | role |
|---|---|
| `MatchIntroTypes.ts` | data contract, ranking, palette |
| `MatchIntroTimeline.ts` | pure layout + timeline (`computeFrame(t)`) |
| `MatchIntroStage.ts` | one character "photo booth": pose, lights, camera, ink contour |
| `MatchIntroCompositor.ts` | 2D shader passes: blades, backgrounds, flashes, wipe |
| `MatchIntroOverlay.ts` | DOM stickers: names, stats, MVP badge, VS |
| `MatchIntroCinematic.ts` | orchestration, playback, cues, cleanup |
| `gameCharacterFactory.ts` | game adapter (Potato clone + outfit runtime) |
| `matchIntroSounds.ts` | optional default SFX mapping (existing assets) |
| `matchIntroPreview.ts` | dev preview page script |
