import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadCharacterAsset, stripEnemyOutline } from "../../characters/PotatoCharacter";
import { CharacterOutfitSlot, astronautSlotsOf, getAstronautLibrary } from "../../cosmetics/astronaut/AstronautRuntime";
import type { IntroCharacter, IntroCharacterClips, IntroCharacterFactory, MatchIntroPlayer } from "./MatchIntroTypes";

/**
 * MATCH INTRO — game adapter: one dressed Potato clone per player, built
 * from the SAME shared asset and outfit runtime as the in-game avatars
 * (nothing new to download once the match assets are loaded).
 *
 *   playMatchIntro(players, createGameIntroCharacterFactory(), { mapName: "GIVRE" })
 *
 * The clone is the intro's own instance: it never touches a live avatar.
 * The red enemy contour is stripped (the intro draws its own ink outline)
 * and the outfit is applied BEFORE the character is handed over, so the
 * player shows up dressed from the very first frame.
 */
export function createGameIntroCharacterFactory(): IntroCharacterFactory {
  return async (player: MatchIntroPlayer): Promise<IntroCharacter> => {
    const selection = player.cosmetics ?? {};
    const wantsOutfit = astronautSlotsOf(selection).length > 0;
    // The library promise is shared session-wide: loaded once, never reloaded.
    const [asset] = await Promise.all([loadCharacterAsset(), wantsOutfit ? getAstronautLibrary() : null]);

    const root = skeletonClone(asset.template);
    stripEnemyOutline(root);

    let outfit: CharacterOutfitSlot | null = null;
    if (wantsOutfit) {
      // Library already loaded above → the outfit applies synchronously here
      // (a failed pack simply keeps the base look, logged by the runtime).
      outfit = new CharacterOutfitSlot({ context: "tp" });
      outfit.setTarget(root);
      outfit.setSelection(selection);
    }

    const variants = asset.clips.jumpVariants ?? [];
    const clips: IntroCharacterClips = {
      idle: asset.clips.idle,
      run: asset.clips.run,
      jump: asset.clips.jump,
      jumpLeft: variants.find((c) => c.name === "Jump_LeftLead"),
      jumpRight: variants.find((c) => c.name === "Jump_RightLead"),
      dash: asset.clips.dash,
      slide: asset.clips.slide,
    };

    return {
      root,
      clips,
      dispose() {
        // Restores the base clone and frees the outfit's private resources;
        // shared geometries / materials stay untouched (the game keeps using them).
        outfit?.dispose();
        outfit = null;
      },
    };
  };
}
