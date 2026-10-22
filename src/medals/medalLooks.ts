import { MedalStyles } from "./MedalConfig";
import { MedalType } from "./MedalType";

/** Chain length from which the badge goes "hype" (faster rays, bigger pop). */
export const HYPE_CHAIN = 2;

/**
 * How the medal badge looks for one medal at its place in the chain — exactly
 * what MedalHUD.show sets: the tier stars (class `stars-N`, none at 0), the
 * hype look (class `hype`), the label and the accent colour. Pure (no DOM):
 * the HUD warm-up and the tests read the same rule as the badge.
 */
export interface MedalLook {
  readonly medal: MedalType;
  readonly stars: number;
  readonly hype: boolean;
  readonly label: string;
  readonly color: string;
}

export function medalLook(medal: MedalType, chainIndex: number): MedalLook {
  const style = MedalStyles[medal];
  return { medal, stars: style.stars, hype: chainIndex >= HYPE_CHAIN, label: style.label, color: style.color };
}

/**
 * The medal looks the HUD warm-up draws at load (ui/HudWarmup.ts), as
 * [medal, chainIndex]. Measured on the PC gamer (RTX 2080 Super, 240 Hz,
 * 22/10): the FIRST badge of a look the warm-up never drew made Chrome's GPU
 * process prepare it for ~12-14 ms (the first HEADSHOT of the session: a
 * 16.7 ms frame = game 3.4 + browser 0.6 + GPU wait ~12, the game's own GPU
 * work 1.5-2.4 ms); the second one cost nothing. The badge's star count
 * changes how it is built (no star at all for HEADSHOT / SMASHED / HOME RUN /
 * MOLED / IMPALED, two for DOUBLE KILL), so every star count the game shows
 * is drawn once here, with the hype look (three stars) on top. A medal whose
 * style gets a new star count — or any new look of the badge — goes here.
 */
export const WARM_MEDAL_LOOKS: readonly (readonly [MedalType, number])[] = [
  [MedalType.KILL, 0], // the first kill of a combo: one star
  [MedalType.DOUBLE_KILL, 1], // the second kill: two stars, before any hype
  [MedalType.HEADSHOT, 1], // the medal after the combo medal: no star
  [MedalType.TRIPLE_KILL, 2], // the hype look: three stars (every art, see rareLooks)
];
