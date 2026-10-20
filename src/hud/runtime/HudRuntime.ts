/**
 * HUD runtime — PLACEHOLDER (replaced by the real runtime on branch
 * hud/runtime). Same export as the real module so the game side compiles
 * against it meanwhile. See src/hud/protocol.ts.
 */
import type { CreateHudRuntime } from "../protocol";

export const createHudRuntime: CreateHudRuntime = () => {
  throw new Error("HUD runtime not implemented yet");
};
