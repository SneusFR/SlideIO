// GivrePostChain — the `?diag=` post chain of Givre, without WebGL.
// Usage (repo root):  npx --prefix backend tsx scripts/test-givre-post-chain.mts
//   1. givrePostSetup: reference by default, each switch, precedence, no
//      `direct` world with the outline feature;
//   2. world targets: format / type / colour space / internal format of each
//      format, `direct` = an XR-flagged target that its clone() keeps;
//   3. GivreOutputChain in a real EffectComposer (recording renderer): which
//      target each pass draws into and reads, per route, FXAA on and off —
//      the reference chain unchanged (two swaps per frame), the other routes
//      keep the world in ONE buffer; the RGBA8 intermediate follows setSize.
import assert from "node:assert/strict";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { asFullscreenPass } from "../src/effects/FullscreenPass.ts";
import {
  DirectWorldTarget,
  GIVRE_POST_DEFAULT,
  GIVRE_POST_DIAGS,
  GIVRE_POST_REFERENCE,
  GivreOutputChain,
  abPostChains,
  abSetups,
  createWorldTarget,
  describePostSetup,
  diffPixels,
  givrePostSetup,
  isValidPostSetup,
  worldBytesPerPixel,
  worldTargetOptions,
  type GivreOutputRoute,
  type GivrePostSetup,
} from "../src/effects/GivrePostChain.ts";
import { perfExperiments } from "../src/ui/perfDiag.ts";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`OK   ${label}`);
};

// ---------------------------------------------------------------- 1. setup
{
  const setup = (q: string, outlines = false) => givrePostSetup(perfExperiments(q), { outlines });
  assert.deepEqual(setup(""), GIVRE_POST_REFERENCE);
  assert.deepEqual(setup("?diag=noflush,scale50"), GIVRE_POST_REFERENCE);
  assert.deepEqual(setup("?diag=out8"), { world: "rgba16f", output: "rgba8" });
  assert.deepEqual(setup("?diag=fused"), { world: "rgba16f", output: "fused" });
  // a world format brings its own intermediate (never the composer's other buffer in that format)
  assert.deepEqual(setup("?diag=world11"), { world: "r11g11b10f", output: "rgba8" });
  assert.deepEqual(setup("?diag=worldsrgb"), { world: "srgb8", output: "rgba8" });
  assert.deepEqual(setup("?diag=world11,out8"), { world: "r11g11b10f", output: "rgba8" });
  assert.deepEqual(setup("?diag=worldsrgb,fused"), { world: "srgb8", output: "fused" });
  assert.deepEqual(setup("?diag=OUT8, WorldSRGB"), { world: "srgb8", output: "rgba8" }, "case / spaces");
  // precedence
  assert.deepEqual(setup("?diag=out8,fused"), { world: "rgba16f", output: "fused" });
  assert.deepEqual(setup("?diag=fused8"), { world: "rgba16f", output: "fused8" });
  assert.deepEqual(setup("?diag=fused,fused8,out8"), { world: "rgba16f", output: "fused8" });
  assert.deepEqual(setup("?diag=worldsrgb,fused8"), { world: "srgb8", output: "fused8" });
  assert.deepEqual(setup("?diag=world11,worldsrgb"), { world: "srgb8", output: "rgba8" });
  assert.deepEqual(setup("?diag=direct,out8,world11,fused"), { world: "direct", output: "none" });
  // the outline passes compose a linear rim: never `direct` with the feature on
  assert.deepEqual(setup("?diag=direct", true), GIVRE_POST_REFERENCE);
  assert.deepEqual(setup("?diag=direct,out8", true), { world: "rgba16f", output: "rgba8" });
  for (const q of ["", "?diag=out8", "?diag=fused", "?diag=world11", "?diag=worldsrgb", "?diag=direct", "?diag=direct,out8"]) {
    assert.ok(isValidPostSetup(setup(q)), q);
  }
  // every documented switch but postab (a console tool) and postref changes the chain
  for (const d of GIVRE_POST_DIAGS) {
    if (d === "postab" || d === "postref") assert.deepEqual(setup(`?diag=${d}`), GIVRE_POST_REFERENCE);
    else assert.notDeepEqual(setup(`?diag=${d}`), GIVRE_POST_REFERENCE, d);
  }
  // no switch → the default (the reference today); postref wins over everything
  assert.deepEqual(GIVRE_POST_DEFAULT, GIVRE_POST_REFERENCE);
  assert.deepEqual(setup("?diag=postref,fused,direct"), GIVRE_POST_REFERENCE);
  assert.notEqual(setup(""), GIVRE_POST_DEFAULT, "a copy, never the frozen constant");
  for (const s of Object.values(abSetups(true))) assert.ok(isValidPostSetup(s), describePostSetup(s));
  assert.equal(Object.hasOwn(abSetups(false), "direct"), false, "direct (a program recompile) only on request");
  assert.equal(isValidPostSetup({ world: "direct", output: "half" }), false);
  assert.equal(isValidPostSetup({ world: "rgba16f", output: "none" }), false);
  assert.equal(describePostSetup(GIVRE_POST_REFERENCE), "world rgba16f · out half");
  assert.ok(Object.isFrozen(GIVRE_POST_REFERENCE));
  ok("givrePostSetup: reference by default, each switch, precedence, no direct with outlines");
}

// ---------------------------------------------------------------- 2. targets
{
  const base: THREE.RenderTargetOptions = {
    depthBuffer: true,
    stencilBuffer: true,
    samples: 4,
    resolveDepthBuffer: false,
    resolveStencilBuffer: false,
  };
  const half = createWorldTarget(64, 32, "rgba16f", base);
  assert.equal(half.texture.type, THREE.HalfFloatType);
  assert.equal(half.texture.format, THREE.RGBAFormat);
  assert.equal(half.samples, 4);
  assert.equal(half.stencilBuffer, true);
  assert.equal(half.resolveDepthBuffer, false);
  assert.equal((half as { isXRRenderTarget?: boolean }).isXRRenderTarget, undefined);

  const r11 = createWorldTarget(64, 32, "r11g11b10f", base);
  assert.equal(r11.texture.type, THREE.UnsignedInt101111Type);
  assert.equal(r11.texture.format, THREE.RGBFormat);

  const srgb = createWorldTarget(64, 32, "srgb8", base);
  assert.equal(srgb.texture.type, THREE.UnsignedByteType);
  assert.equal(srgb.texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(srgb.texture.internalFormat, null, "three picks SRGB8_ALPHA8 from the colour space");

  const direct = createWorldTarget(64, 32, "direct", base);
  assert.ok(direct instanceof DirectWorldTarget);
  assert.equal((direct as { isXRRenderTarget?: boolean }).isXRRenderTarget, true);
  assert.equal(direct.texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(direct.texture.internalFormat, "RGBA8");
  // EffectComposer's second buffer is a clone: it must draw the same way.
  const clone = direct.clone();
  assert.ok(clone instanceof DirectWorldTarget);
  assert.equal((clone as { isXRRenderTarget?: boolean }).isXRRenderTarget, true);
  assert.equal(clone.texture.internalFormat, "RGBA8");
  assert.equal(clone.texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(clone.samples, 4);
  assert.equal(r11.clone().texture.type, THREE.UnsignedInt101111Type);

  assert.equal(worldBytesPerPixel("rgba16f"), 8);
  for (const f of ["r11g11b10f", "srgb8", "direct"] as const) assert.equal(worldBytesPerPixel(f), 4);
  assert.deepEqual(worldTargetOptions("rgba16f"), { type: THREE.HalfFloatType });
  ok("world targets: formats, direct = XR-flagged target kept by clone()");
}

// ---------------------------------------------------------------- 3. routing
{
  type Call = { target: THREE.WebGLRenderTarget | null; material: string; reads: THREE.Texture | null; subtexel: unknown };
  const calls: Call[] = [];
  let current: THREE.WebGLRenderTarget | null = null;
  const W = 40;
  const H = 20;
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.set(W, H),
    setRenderTarget(rt: THREE.WebGLRenderTarget | null) {
      current = rt;
    },
    getRenderTarget: () => current,
    clear() {
      throw new Error("fullscreen passes never clear");
    },
    render(mesh: THREE.Mesh) {
      const m = mesh.material as THREE.ShaderMaterial;
      calls.push({
        target: current,
        material: m.name,
        reads: (m.uniforms?.tDiffuse?.value as THREE.Texture) ?? null,
        subtexel: m.defines?.SUBTEXEL_BITS,
      });
    },
    getContext: () => ({ flush() {} }),
  };
  const r = renderer as unknown as THREE.WebGLRenderer;

  /** Stand-in for the world RenderPass: draws into readBuffer, no swap. */
  class WorldPass extends Pass {
    drawnInto: THREE.WebGLRenderTarget[] = [];
    constructor() {
      super();
      this.needsSwap = false;
    }
    render(_r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
      this.drawnInto.push(readBuffer);
    }
  }

  const build = (route: GivreOutputRoute, fxaaOn: boolean) => {
    const target = createWorldTarget(W, H, route === "none" ? "direct" : "rgba16f", { depthBuffer: true, stencilBuffer: true });
    const composer = new EffectComposer(r, target);
    const world = new WorldPass();
    const output = asFullscreenPass(new OutputPass());
    const fxaa = asFullscreenPass(new FXAAPass());
    fxaa.enabled = fxaaOn;
    const chain = new GivreOutputChain(output, fxaa, route);
    composer.addPass(world);
    composer.addPass(output);
    composer.addPass(fxaa);
    return { composer, world, chain, output, fxaa };
  };
  const frame = (composer: EffectComposer): Call[] => {
    calls.length = 0;
    composer.render(1 / 60);
    return [...calls];
  };

  // half (reference): output → the other buffer, FXAA → canvas, two swaps per frame.
  {
    const { composer, world } = build("half", true);
    const rt1 = composer.renderTarget1;
    const rt2 = composer.renderTarget2;
    for (let i = 0; i < 3; i++) {
      const c = frame(composer);
      assert.equal(c.length, 2);
      assert.equal(world.drawnInto[i], rt2, "world always in the composer's read buffer");
      assert.deepEqual([c[0].material, c[0].target, c[0].reads], ["OutputShader", rt1, rt2.texture]);
      assert.deepEqual([c[1].material, c[1].target, c[1].reads], ["FXAAShader", null, rt1.texture]);
    }
    assert.equal(composer.readBuffer, rt2);
  }
  // rgba8: output → the dedicated RGBA8 target, FXAA reads it; the world keeps ONE buffer.
  {
    const { composer, world, chain } = build("rgba8", true);
    const rt2 = composer.renderTarget2;
    assert.equal(chain.intermediate.texture.type, THREE.UnsignedByteType);
    assert.equal(chain.intermediate.depthBuffer, false);
    assert.deepEqual([chain.intermediate.width, chain.intermediate.height], [W, H]);
    for (let i = 0; i < 3; i++) {
      const c = frame(composer);
      assert.equal(world.drawnInto[i], rt2);
      assert.deepEqual([c[0].material, c[0].target, c[0].reads], ["OutputShader", chain.intermediate, rt2.texture]);
      assert.deepEqual([c[1].material, c[1].target, c[1].reads], ["FXAAShader", null, chain.intermediate.texture]);
    }
    composer.setSize(25, 15);
    assert.deepEqual([chain.intermediate.width, chain.intermediate.height], [25, 15]);
  }
  // fused / fused8: no output draw, the fused FXAA reads the world (exact / 8-bit weights).
  for (const route of ["fused", "fused8"] as const) {
    const { composer, world } = build(route, true);
    const rt2 = composer.renderTarget2;
    for (let i = 0; i < 2; i++) {
      const c = frame(composer);
      assert.equal(world.drawnInto[i], rt2);
      assert.equal(c.length, 1);
      assert.deepEqual([c[0].material, c[0].target, c[0].reads], ["OutputFXAAShader", null, rt2.texture]);
      assert.equal(c[0].subtexel, route === "fused8" ? 8 : undefined);
    }
  }
  // none (direct world): FXAA reads the world as it is.
  {
    const { composer, world } = build("none", true);
    const rt2 = composer.renderTarget2;
    for (let i = 0; i < 2; i++) {
      const c = frame(composer);
      assert.equal(world.drawnInto[i], rt2);
      assert.equal(c.length, 1);
      assert.deepEqual([c[0].material, c[0].target, c[0].reads], ["FXAAShader", null, rt2.texture]);
    }
  }
  // FXAA off (MSAA / none): the output pass draws the canvas — a plain copy for the direct world.
  for (const route of ["half", "rgba8", "fused", "fused8", "none"] as const) {
    const { composer } = build(route, false);
    const first = composer.renderTarget2;
    const c = frame(composer);
    assert.equal(c.length, 1, route);
    assert.deepEqual([c[0].material, c[0].target, c[0].reads], [route === "none" ? "GivreDirectCopy" : "OutputShader", null, first.texture], route);
  }
  // The route can change live (DEV A/B): next frame follows.
  {
    const { composer, chain } = build("half", true);
    frame(composer);
    chain.route = "rgba8";
    const c = frame(composer);
    assert.equal(c[0].target, chain.intermediate);
    assert.equal(c[1].reads, chain.intermediate.texture);
    chain.route = "half";
    const back = frame(composer);
    assert.equal(back[1].target, null);
    assert.notEqual(back[0].target, chain.intermediate);
  }
  ok("GivreOutputChain: targets drawn / read per route, FXAA on and off, live route change");
}

// ---------------------------------------------------------------- 4. A/B tool
{
  const a = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 255, 5, 5, 5, 255, 1, 2, 3, 4]);
  const b = new Uint8Array([10, 20, 30, 255, 1, 0, 0, 255, 5, 9, 5, 255, 1, 2, 3, 0]);
  assert.deepEqual(diffPixels(a, a), { pixels: 0, percent: 0, max: 0, oneLevel: 0, alpha: 0 });
  assert.deepEqual(diffPixels(a, b), { pixels: 3, percent: 75, max: 4, oneLevel: 1, alpha: 1 });
  assert.throws(() => diffPixels(a, b.subarray(4)));

  // abPostChains: reference first, each setup after a warm frame, the session's chain restored.
  const log: string[] = [];
  let current: GivrePostSetup = { world: "srgb8", output: "rgba8" };
  const image = (s: GivrePostSetup): number => (s.output === "fused" ? 7 : s.world === "srgb8" ? 3 : 0);
  const fakeGl = {
    drawingBufferWidth: 2,
    drawingBufferHeight: 1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, px: Uint8Array) {
      px.fill(100);
      px[0] = 100 + image(current); // one channel of the first pixel tells which chain drew it
    },
  } as unknown as WebGL2RenderingContext;
  const chain = {
    current: () => current,
    set: (s: GivrePostSetup) => {
      current = s;
      log.push(`set ${describePostSetup(s)}`);
    },
    render: () => log.push("render"),
  };
  const result = abPostChains(chain, fakeGl, {
    fused: { world: "rgba16f", output: "fused" },
    worldsrgb: { world: "srgb8", output: "rgba8" },
  });
  assert.equal(result.fused.max, 7);
  assert.equal(result.fused.pixels, 1);
  assert.equal(result.worldsrgb.max, 3);
  assert.equal(result.repeat.pixels, 0);
  assert.deepEqual(current, { world: "srgb8", output: "rgba8" }, "session chain restored");
  assert.equal(log[0], "set world rgba16f · out half");
  assert.deepEqual(log.slice(1, 3), ["render", "render"]);
  assert.equal(log.filter((l) => l === "render").length, 2 + 2 * 2 + 1);
  ok("A/B tool: pixel diff, reference first, warm frame per chain, session chain restored");
}

console.log(`\n${passed} groups passed`);
