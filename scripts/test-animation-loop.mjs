/**
 * Menu -> gameplay lifecycle regression, using the actual Game methods and
 * installed Three.js scheduler. Only the browser clock, rAF and renderer
 * drawing are stubbed; no WebGL context or assets need to be constructed.
 * Run: npm run test:animation-loop
 */
import assert from "node:assert/strict";
import * as THREE from "three";
import { WebGLAnimation } from "three/src/renderers/webgl/WebGLAnimation.js";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom",
});
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

try {
  const { Game } = await server.ssrLoadModule("/src/game/Game.ts");
  const { DebugHUD } = await server.ssrLoadModule("/src/ui/DebugHUD.ts");
  const debugElement = { textContent: "" };
  globalThis.document = { getElementById: () => debugElement };

  function harness(hz, maxFps = Infinity) {
    let now = 0;
    let tickIndex = 0;
    let requestId = 0;
    const pending = new Map();
    const resizeListeners = new Set();
    let renders = 0;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => now },
    });
    globalThis.window = {
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener(type, cb) {
        assert.equal(type, "resize");
        resizeListeners.add(cb);
      },
      removeEventListener(type, cb) {
        assert.equal(type, "resize");
        resizeListeners.delete(cb);
      },
    };

    const animation = WebGLAnimation();
    animation.setContext({
      requestAnimationFrame(cb) { pending.set(++requestId, cb); return requestId; },
      cancelAnimationFrame(id) { pending.delete(id); },
    });
    // Same callback indirection as WebGLRenderer.setAnimationLoop().
    let appCallback = null;
    animation.setAnimationLoop(time => appCallback?.(time));
    const renderer = {
      shadowMap: {},
      render() { renders++; },
      setAnimationLoop(cb) {
        appCallback = cb;
        if (cb === null) animation.stop();
        else animation.start();
      },
    };

    // Do not construct Game: that would load every asset and require WebGL.
    // These are the dependencies of the REAL lifecycle methods under test.
    const game = Object.create(Game.prototype);
    Object.assign(game, {
      renderer,
      scene: new THREE.Scene(),
      fpsCamera: { camera: new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 400) },
      updateCamera() {},
      hud: new DebugHUD(),
      lastTime: 0,
      elapsed: 0,
      menuPreview: null,
      menuLookAt: new THREE.Vector3(0, 1, 0),
      staticShadows: true,
      frameIntervalMs: Number.isFinite(maxFps) ? 1000 / maxFps : 0,
      nextFrameAt: 0,
    });
    const frames = [];
    let calls = 0;
    // Replace the heavy simulation, but keep the real cap and lifecycle.
    game.frame = timestamp => {
      calls++;
      if (!game.frameCapSkip(now)) frames.push(timestamp);
    };

    return {
      game, renderer, pending, resizeListeners, frames,
      get calls() { return calls; },
      get renders() { return renders; },
      advanceClock(ms) { now += ms; },
      async tick() {
        now = ++tickIndex * 1000 / hz;
        // A browser snapshots the callbacks for this refresh; newly queued
        // callbacks wait for the next one. Microtasks run after callbacks.
        for (const id of [...pending.keys()]) {
          const cb = pending.get(id);
          if (!cb) continue;
          pending.delete(id);
          cb(now);
          await Promise.resolve();
        }
      },
    };
  }

  for (const hz of [60, 120, 144]) {
    const h = harness(hz);
    h.game.startMenuPreview();
    h.game.startMenuPreview(); // idempotent
    assert.equal(h.pending.size, 1);
    assert.equal(h.resizeListeners.size, 1);
    await h.tick();

    // Real main.ts order: await the flight, THEN start gameplay.
    let entered = false;
    const enter = (async () => {
      await h.game.beginMenuPlayTransition();
      h.game.start();
      entered = true;
    })();
    for (let i = 0; i < hz * 2 && !entered; i++) await h.tick();
    assert.ok(entered, "flight must complete");
    await enter;
    assert.equal(h.game.menuPreview, null);
    assert.equal(h.resizeListeners.size, 0, "preview listener cleaned up");
    assert.equal(h.pending.size, 1, `solo handoff @${hz} Hz must leave ONE rAF chain`);

    h.game.start(); // repeated start must only replace the callback
    const callsBefore = h.calls;
    for (let i = 0; i < hz; i++) await h.tick();
    assert.equal(h.calls - callsBefore, hz, "one gameplay call per refresh");
    assert.equal(new Set(h.frames).size, h.frames.length, "no duplicate timestamps");
    assert.equal(h.pending.size, 1, "single chain persists");
    h.renderer.setAnimationLoop(null);
    assert.equal(h.pending.size, 0, "stopping outside a callback leaves no orphan");
    console.log(`PASS solo flight + repeated start @${hz} Hz`);
  }

  {
    const h = harness(120);
    h.game.startMenuPreview();
    await h.tick();
    // Multiplayer stops the preview OUTSIDE its animation callback while
    // remote assets are prepared, then enters without a camera flight.
    h.game.stopMenuPreview();
    h.game.stopMenuPreview();
    assert.equal(h.pending.size, 0);
    assert.equal(h.resizeListeners.size, 0);
    await h.game.beginMenuPlayTransition(); // no preview: immediate resolution
    h.game.start();
    for (let i = 0; i < 120; i++) await h.tick();
    assert.equal(h.calls, 120);
    assert.equal(h.pending.size, 1);
    h.renderer.setAnimationLoop(null);
    assert.equal(h.pending.size, 0);
    console.log("PASS direct multiplayer-style entry + repeated stop");
  }

  for (const hz of [60, 120]) {
    const h = harness(hz, 60);
    h.game.startMenuPreview();
    let finished = false;
    const flight = h.game.beginMenuPlayTransition().then(() => { finished = true; });
    for (let i = 0; i < hz * 2 && !finished; i++) await h.tick();
    assert.ok(finished, "capped flight resolves");
    await flight;
    const rendersAtHandoff = h.renders;
    // A delayed caller must not replay the completed transition or leak
    // callbacks/listeners while the single chain waits for start().
    for (let i = 0; i < 5; i++) await h.tick();
    assert.equal(h.renders, rendersAtHandoff);
    assert.equal(h.pending.size, 1);
    assert.equal(h.resizeListeners.size, 0);
    h.game.start();
    for (let i = 0; i < hz; i++) await h.tick();
    assert.equal(h.calls, hz, "cap does not duplicate/remove the rAF chain");
    assert.equal(h.frames.length, 60, "60 FPS cap on 60/120 Hz clock");
    h.game.setFpsCap(Infinity);
    const framesBefore = h.frames.length;
    for (let i = 0; i < hz; i++) await h.tick();
    assert.equal(h.frames.length - framesBefore, hz, "OFF restores full callback cadence");
    assert.equal(h.pending.size, 1);
    h.renderer.setAnimationLoop(null);
    assert.equal(h.pending.size, 0);
    console.log(`PASS capped flight + delayed handoff + live cap OFF @${hz} Hz`);
  }

  {
    const movement = {
      velocity: new THREE.Vector3(), horizontalSpeed: 0, grounded: true,
      state: "GROUNDED", phaseDebug: { wallThickness: 0 },
    };
    const hud = new DebugHUD();
    // Two callbacks per 60 Hz timestamp: report 120 calls/s but 60 unique/s.
    for (let i = 0; i < 30; i++) {
      const timestamp = i * 1000 / 60;
      assert.equal(hud.sampleAnimationFrame(timestamp), true);
      assert.equal(hud.sampleAnimationFrame(timestamp), false);
    }
    assert.equal(hud.sampleAnimationFrame(500), true);
    hud.update(0.1, movement);
    assert.match(debugElement.textContent, /60 unique\/s \/ 120 calls\/s \(dup 30\)/);
    assert.equal(hud.sampleAnimationFrame(500), false, "boundary duplicate belongs to next window");
    hud.resetFrameStats();
    // Reset must allow a new session to start at the previous timestamp.
    assert.equal(hud.sampleAnimationFrame(500), true);
    hud.resetFrameStats();
    for (let i = 0; i <= 120; i++) {
      hud.sampleAnimationFrame(i * 1000 / 120);
      if (i > 0) hud.update(1 / 120, movement);
    }
    assert.match(debugElement.textContent, /120 unique\/s \/ 120 calls\/s \(dup 0\)/);
    assert.match(debugElement.textContent, /FPS:\s+120\n/);
    assert.ok(hud.sampleAnimationFrame(10000), "return from a suspended tab is accepted");
    console.log("PASS HUD duplicate detection, boundary, reset and genuine 120 Hz");
  }

  {
    const h = harness(120);
    const reachedGameplay = new Error("passed the frame gates");
    Object.defineProperty(h.game, "playerCombatant", {
      get() { throw reachedGameplay; },
    });
    h.game.input = { pointerLocked: true, mouseDX: 3, endFrame() {
      throw new Error("input must not be consumed by a skipped callback");
    } };
    // Execute the REAL frame method up to gameplay, not the harness stub.
    assert.throws(() => Game.prototype.frame.call(h.game, 100), error => error === reachedGameplay);
    h.advanceClock(5); // performance.now differs, but rAF timestamp is identical
    assert.doesNotThrow(() => Game.prototype.frame.call(h.game, 100));
    assert.equal(h.game.input.mouseDX, 3);
    assert.throws(() => Game.prototype.frame.call(h.game, 108), error => error === reachedGameplay);

    h.game.setFpsCap(60);
    h.advanceClock(20);
    assert.throws(() => Game.prototype.frame.call(h.game, 125), error => error === reachedGameplay);
    h.advanceClock(8);
    assert.doesNotThrow(() => Game.prototype.frame.call(h.game, 133), "early capped tick skips gameplay");
    assert.equal(h.game.input.mouseDX, 3);
    h.game.setFpsCap(Infinity);
    h.advanceClock(8);
    assert.throws(() => Game.prototype.frame.call(h.game, 141), error => error === reachedGameplay);
    console.log("PASS real frame duplicate/cap gates preserve pending input");
  }
} finally {
  restoreGlobal("window", originalWindow);
  restoreGlobal("performance", originalPerformance);
  restoreGlobal("document", originalDocument);
  await server.close();
}