/**
 * Harness host entry (runtime-harness.mjs), this tree: `?mode=frame` drives
 * the HUD in its iframe (/hud.html), `?mode=inline` runs the same runtime in
 * this page — the fallback the game uses when the iframe is not available.
 */
import { startHost } from "./runtime-host";

const frame = new URLSearchParams(location.search).get("mode") === "frame";
startHost(frame ? null : async () => (await import("../../src/hud/runtime/HudRuntime")).createHudRuntime());
