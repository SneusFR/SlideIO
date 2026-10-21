// OVERDRAW PROBE — runs INSIDE the game page (DEV build: window.__game), installed by
// tools/perf/overdraw-bench.mjs (`page.evaluate(installOverdrawProbe)`; self-contained: no import).
//
// Counts, per pixel of the Givre world pass, the fragments the GPU
//   RASTERISES  every covered pixel of every triangle (no depth test at all),
//   SHADES      passes the depth test when drawn in the REAL order (three's sorted opaque list,
//               triangles in index order) — ideal early-Z, a lower bound of what real hardware
//               shades (hierarchical-Z tiles, fragments in flight: real early-Z rejects less),
//   KEEPS       the visible surface (1 per pixel),
// per view and per draw. How: every opaque draw is re-issued in the recorded order with an
// additive counting material that keeps its side / depth / stencil / polygon-offset state (same
// geometry, same object: skinning, instancing, morphs all apply); the counts are read back after
// each draw (onAfterRender). Front and back faces are counted apart (gl_FrontFacing).
// Transparent objects are left out (drawn after every opaque, they never change the opaque counts).
export function installOverdrawProbe() {
  const g = window.__game;
  const renderer = g.renderer;
  const gl = renderer.getContext();
  const scene = g.scene;
  const cam = g.fpsCamera.camera;
  const sky = g.spaceSky;
  const dome = sky && sky.dome;
  if (!g.composer || !dome) throw new Error("overdraw probe: Givre composer + sky dome expected");
  const MeshBasicMaterial = dome.material.constructor;
  const RenderTarget = g.composer.renderTarget1.constructor;
  // (BufferGeometry / BufferAttribute: taken from the map batch itself — the dome's are the
  // SphereGeometry / Float32BufferAttribute subclasses, which would turn an index into floats.)
  const Color = scene.background.constructor;
  // three constants (stable numeric values)
  const FrontSide = 0, BackSide = 1, DoubleSide = 2;
  const NoBlending = 0, CustomBlending = 5, AddEquation = 100, OneFactor = 201;

  // The game's opaque sort (recorded by the bench's init script when the game installed it): every
  // probe render that changes the sort puts THIS one back (never whatever was set last).
  const gameSort = renderer.__odpOpaqueSort ?? null;
  if (!gameSort) console.warn("overdraw probe: the game's opaque sort was not recorded (three's default assumed)");
  let sortOverride = null;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const n4 = w * h * 4;
  const rt = new RenderTarget(w, h, { depthBuffer: true, stencilBuffer: true });
  const invisible = new MeshBasicMaterial({ visible: false });
  const cur = new Uint8Array(n4);
  const prev = new Uint8Array(n4);

  const kindOf = (o) => {
    for (let p = o; p; p = p.parent) {
      if (p.name === "givre_prepass") return "prepass"; // the game's own depth prepass (?diag=prepass)
      if (p.name === "givre_01_merged") return "map";
      if (p.name === "givre_sky") return "sky";
      if (p.name === "givre_01_fond") return "backdrop";
      if (p.name === "givre_01") return "decor";
    }
    return "other";
  };
  const sideName = (s) => (s === FrontSide ? "front" : s === BackSide ? "back" : "double");
  const trisOf = (geo, object, group) => {
    const count = group ? group.count : geo.index ? geo.index.count : geo.getAttribute("position").count;
    const range = Math.min(count, geo.drawRange.count);
    const inst = object.isInstancedMesh ? object.count : 1;
    return Math.floor(range / 3) * inst;
  };

  // ------------------------------------------------------------------ pose
  function pose(p) {
    cam.position.set(p.x, p.y, p.z);
    cam.rotation.set(((p.pitch ?? 0) * Math.PI) / 180, ((p.yaw ?? 0) * Math.PI) / 180, 0, "YXZ");
    cam.fov = p.fov ?? 92;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (g.viewmodelSystem?.syncCamera) g.viewmodelSystem.syncCamera(cam);
    sky.update(0, 0, cam);
    sky.group.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ capture
  // One REAL frame (composer: world pass, FP overlay, output…); the world pass's opaque list is
  // read back from three's render lists (same order as drawn).
  let items = [];
  function capture() {
    g.renderComposer();
    const list = renderer.renderLists.get(scene, 0);
    items = list.opaque.map((it) => ({
      object: it.object,
      geometry: it.geometry,
      material: it.material,
      group: it.group,
      z: it.z,
      kind: kindOf(it.object),
    }));
    return {
      w,
      h,
      opaque: items.map((it, rank) => ({
        rank,
        name: it.object.name || it.object.type,
        kind: it.kind,
        material: it.material.name || it.material.type,
        side: sideName(it.material.side),
        tris: trisOf(it.geometry, it.object, it.group),
        skinned: !!it.object.isSkinnedMesh,
        instanced: !!it.object.isInstancedMesh,
        renderOrder: it.object.renderOrder,
        depthWrite: it.material.depthWrite,
        depthTest: it.material.depthTest,
        colorWrite: it.material.colorWrite,
        alphaTest: it.material.alphaTest,
        polygonOffset: it.material.polygonOffset,
        z: +it.z.toFixed(2),
      })),
      transparent: list.transparent.map((it) => ({
        name: it.object.name || it.object.type,
        kind: kindOf(it.object),
        material: it.material.name || it.material.type,
        tris: trisOf(it.geometry, it.object, it.group),
      })),
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      sort: sortOverride ? sortOverride.name || "override" : gameSort ? gameSort.name || "game" : "three default",
    };
  }

  // ------------------------------------------------------------------ counting materials
  // mode: "shade" (depth as the original, +1 R front / +1 G back), "raster" (no depth test),
  // "pre" (depth prepass: depth as the original, +1 B), "id" (owner rank in RG, back face in B).
  function countMaterial(orig, mode, rank, isSky, forceSide) {
    const m = new MeshBasicMaterial();
    m.name = `odp_${mode}`;
    m.side = forceSide ?? orig.side;
    m.depthTest = mode === "raster" ? false : orig.depthTest;
    m.depthWrite = mode === "raster" ? false : orig.depthWrite;
    m.depthFunc = orig.depthFunc;
    m.polygonOffset = orig.polygonOffset;
    m.polygonOffsetFactor = orig.polygonOffsetFactor;
    m.polygonOffsetUnits = orig.polygonOffsetUnits;
    m.stencilWrite = orig.stencilWrite;
    m.stencilWriteMask = orig.stencilWriteMask;
    m.stencilFunc = orig.stencilFunc;
    m.stencilRef = orig.stencilRef;
    m.stencilFuncMask = orig.stencilFuncMask;
    m.stencilFail = orig.stencilFail;
    m.stencilZFail = orig.stencilZFail;
    m.stencilZPass = orig.stencilZPass;
    m.wireframe = !!orig.wireframe;
    if (orig.alphaTest > 0) {
      m.alphaTest = orig.alphaTest;
      m.map = orig.map ?? null;
      m.alphaMap = orig.alphaMap ?? null;
    }
    m.toneMapped = false;
    m.fog = false;
    m.transparent = false;
    if (mode === "id") {
      m.blending = NoBlending;
      m.color.setRGB(((rank + 1) & 255) / 255, ((rank + 1) >> 8) / 255, 0);
    } else {
      m.blending = CustomBlending;
      m.blendEquation = AddEquation;
      m.blendSrc = OneFactor;
      m.blendDst = OneFactor;
      m.blendEquationAlpha = AddEquation;
      m.blendSrcAlpha = OneFactor;
      m.blendDstAlpha = OneFactor;
    }
    const fs =
      mode === "id"
        ? "gl_FragColor = vec4(diffuse.rg, gl_FrontFacing ? 0.0 : 1.0, 1.0);"
        : mode === "pre"
          ? "gl_FragColor = vec4(0.0, 0.0, 1.0, 0.0) / 255.0;"
          : "gl_FragColor = (gl_FrontFacing ? vec4(1.0, 0.0, 0.0, 0.0) : vec4(0.0, 1.0, 0.0, 0.0)) / 255.0;";
    m.onBeforeCompile = (s) => {
      // The Givre dome sits on the far plane (GivreSky): same here.
      if (isSky) s.vertexShader = s.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n\tgl_Position.z = gl_Position.w;");
      s.fragmentShader = s.fragmentShader.replace("#include <dithering_fragment>", fs);
    };
    m.customProgramCacheKey = () => `odp-${mode}${isSky ? "-sky" : ""}`;
    m.userData.odpRank = rank;
    return m;
  }

  // ------------------------------------------------------------------ index orders
  // Per triangle: centroid x, y, z, |normal.y|, area (m²).
  const S = 5;
  const centroidCache = new Map(); // geometry → Float32Array (S floats per triangle)
  function centroids(geo, index) {
    let c = centroidCache.get(geo);
    if (c && c.length === (index.count / 3) * S) return c;
    const pos = geo.getAttribute("position");
    const n = index.count / 3;
    c = new Float32Array(n * S);
    const p = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        p[k * 3] = pos.getX(v);
        p[k * 3 + 1] = pos.getY(v);
        p[k * 3 + 2] = pos.getZ(v);
      }
      c[t * S] = (p[0] + p[3] + p[6]) / 3;
      c[t * S + 1] = (p[1] + p[4] + p[7]) / 3;
      c[t * S + 2] = (p[2] + p[5] + p[8]) / 3;
      const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
      const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      c[t * S + 3] = Math.abs(ny) / len;
      c[t * S + 4] = len / 2;
    }
    centroidCache.set(geo, c);
    return c;
  }
  /** Triangles of `index` re-ordered by ascending key(cx, cy, cz, triangle, |normal.y|). */
  function sortedIndex(geo, keyOf) {
    const index = geo.index;
    const c = centroids(geo, index);
    const n = index.count / 3;
    const keys = new Float64Array(n);
    for (let t = 0; t < n; t++) keys[t] = keyOf(c[t * S], c[t * S + 1], c[t * S + 2], t, c[t * S + 3]);
    const order = new Uint32Array(n);
    for (let t = 0; t < n; t++) order[t] = t;
    order.sort((a, b) => keys[a] - keys[b] || a - b);
    const src = index.array;
    const dst = new src.constructor(src.length);
    for (let i = 0; i < n; i++) {
      const t = order[i];
      dst[i * 3] = src[t * 3];
      dst[i * 3 + 1] = src[t * 3 + 1];
      dst[i * 3 + 2] = src[t * 3 + 2];
    }
    return new index.constructor(dst, 1); // the batch's own (plain) BufferAttribute class
  }
  const fwd = () => {
    const e = cam.matrixWorld.elements;
    return [-e[8], -e[9], -e[10]];
  };
  /**
   * Index order variants for the map batches (key per triangle centroid, ascending = drawn first):
   *   view       front-to-back for THIS camera (view depth of the centroid) — per-view ideal
   *   viewBack   back-to-front (worst case, reference)
   *   dirN       static: sorted along the nearest of N horizontal directions (N index copies)
   *   cellN      sub-cells of N m drawn front-to-back for this camera (≈ a finer grid split)
   *   horizLast  static: horizontal surfaces (|normal.y| > 0.7: floors, roofs, ceilings) after the
   *              rest, BVH order inside each class
   */
  function orderKey(order) {
    const [fx, fy, fz] = fwd();
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    if (order === "view") return (x, y, z) => (x - px) * fx + (y - py) * fy + (z - pz) * fz;
    if (order === "viewBack") return (x, y, z) => -((x - px) * fx + (y - py) * fy + (z - pz) * fz);
    if (order === "horizLast") return (_x, _y, _z, t, ny) => (ny > 0.7 ? 1e7 : 0) + t;
    let m = /^dir(\d+)$/.exec(order);
    if (m) {
      const n = Number(m[1]);
      const yaw = Math.atan2(fx, fz); // direction angle in XZ
      const k = Math.round((yaw / (2 * Math.PI)) * n);
      const a = (k * 2 * Math.PI) / n;
      const dx = Math.sin(a), dz = Math.cos(a);
      return (x, _y, z) => x * dx + z * dz;
    }
    m = /^cell(\d+)$/.exec(order);
    if (m) {
      const s = Number(m[1]);
      return (x, y, z, t) => {
        const cx = (Math.floor(x / s) + 0.5) * s, cz = (Math.floor(z / s) + 0.5) * s;
        const d = (cx - px) * fx + (y - py) * fy * 0 + (cz - pz) * fz;
        return d * 1e7 + t; // cell order, BVH order inside
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ counting render
  let perDraw = [];
  let lastPrepassTris = 0; // triangles submitted by the last simulated prepass (in-view map batches)
  function onDraw(rank) {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, cur);
    let r = 0, gg = 0, b = 0, touched = 0;
    for (let i = 0; i < n4; i += 4) {
      const dr = cur[i] - prev[i], dg = cur[i + 1] - prev[i + 1], db = cur[i + 2] - prev[i + 2];
      if (dr | dg | db) {
        r += dr;
        gg += dg;
        b += db;
        touched++;
      }
    }
    const st = perDraw[rank];
    st.front += r;
    st.back += gg;
    st.pre += b;
    st.touched += touched;
    prev.set(cur);
  }

  /**
   * One counting render of the recorded opaque list into the probe target.
   * opts: mode ("shade" | "raster" | "id"), perDraw (read back after every draw),
   *       prepass (map batches depth-only first, in the same order),
   *       order (index order variant of the map batches, see orderKey),
   *       frontSide (Set of material names / ranks of map batches forced FrontSide).
   */
  function count(opts) {
    const mode = opts.mode;
    const restore = [];
    const tmpGeos = [];
    const bg = scene.background;
    const clearColor = new Color();
    renderer.getClearColor(clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const prevTarget = renderer.getRenderTarget();
    perDraw = items.map(() => ({ front: 0, back: 0, pre: 0, touched: 0 }));
    const forced = (it, rank) =>
      it.kind === "map" && it.material.side === DoubleSide && opts.frontSide &&
      (opts.frontSide.has(rank) || opts.frontSide.has(it.material.name) || opts.frontSide.has("*"))
        ? FrontSide
        : undefined;
    const makeLookup = (m, onlyMap) => {
      const lookup = new Map();
      items.forEach((it, rank) => {
        if (onlyMap && it.kind !== "map") return;
        let byGroup = lookup.get(it.object);
        if (!byGroup) lookup.set(it.object, (byGroup = new Map()));
        // The game's own prepass draws (depth only): counted in the prepass channel, never an
        // owner in the id image (no colour).
        const mode = it.kind === "prepass" ? (m === "id" ? "id" : "pre") : m;
        const cm = countMaterial(it.material, mode, rank, it.kind === "sky", forced(it, rank));
        if (it.kind === "prepass" && m === "id") cm.colorWrite = false;
        byGroup.set(it.group ? it.group.materialIndex : -1, cm);
      });
      return lookup;
    };
    const swap = (lookup) => {
      scene.traverse((o) => {
        if (!o.material) return;
        if (!o.__odpMaterial) o.__odpMaterial = o.material;
        const orig = o.__odpMaterial;
        const byGroup = lookup.get(o);
        o.material = Array.isArray(orig) ? orig.map((_, i) => byGroup?.get(i) ?? invisible) : (byGroup?.get(-1) ?? invisible);
      });
    };
    const hooked = new Set();
    try {
      // Index order variant (temporary geometry sharing the attributes, own index).
      const key = opts.order && opts.order !== "bvh" ? orderKey(opts.order) : null;
      if (key) {
        for (const it of items) {
          if (it.kind !== "map" || !it.geometry.index || it.group) continue;
          const o = it.object;
          const src = o.geometry;
          const tmp = new src.constructor(); // plain BufferGeometry (merged batch)
          for (const name of Object.keys(src.attributes)) tmp.setAttribute(name, src.getAttribute(name));
          tmp.setIndex(sortedIndex(src, key));
          tmp.boundingBox = src.boundingBox;
          tmp.boundingSphere = src.boundingSphere;
          tmp.drawRange = src.drawRange;
          o.geometry = tmp;
          tmpGeos.push([o, src, tmp]);
        }
      }
      renderer.setOpaqueSort((a, b) => a.material.userData.odpRank - b.material.userData.odpRank);
      renderer.shadowMap.autoUpdate = false;
      scene.background = null;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      prev.fill(0);
      if (opts.perDraw) {
        for (const it of items) {
          const o = it.object;
          if (hooked.has(o)) continue;
          hooked.add(o);
          const own = Object.prototype.hasOwnProperty.call(o, "onAfterRender") ? o.onAfterRender : null;
          o.__odpOwnAfter = own;
          o.onAfterRender = function (r, s, c, geo, mat, grp) {
            if (own) own.call(this, r, s, c, geo, mat, grp);
            if (mat.userData && mat.userData.odpRank !== undefined) onDraw(mat.userData.odpRank);
          };
        }
      }
      if (opts.prepass) {
        // Prepass "lite": only the triangles of at least prepassMinArea m² (big occluders).
        const lite = [];
        lastPrepassTris = 0;
        for (const it of items) {
          if (it.kind !== "map" || it.group) continue;
          const o = it.object;
          const src = o.geometry;
          const n = src.index ? src.index.count / 3 : 0;
          if (!(opts.prepassMinArea > 0) || !src.index) {
            lastPrepassTris += n;
            continue;
          }
          const c = centroids(src, src.index);
          const from = src.index.array;
          const keep = [];
          for (let t = 0; t < n; t++) if (c[t * S + 4] >= opts.prepassMinArea) keep.push(t);
          const dst = new from.constructor(keep.length * 3);
          keep.forEach((t, i) => {
            dst[i * 3] = from[t * 3];
            dst[i * 3 + 1] = from[t * 3 + 1];
            dst[i * 3 + 2] = from[t * 3 + 2];
          });
          const tmp = new src.constructor();
          for (const name of Object.keys(src.attributes)) tmp.setAttribute(name, src.getAttribute(name));
          tmp.setIndex(new src.index.constructor(dst, 1));
          tmp.boundingBox = src.boundingBox;
          tmp.boundingSphere = src.boundingSphere;
          o.geometry = tmp;
          lite.push([o, src, tmp]);
          lastPrepassTris += keep.length;
        }
        swap(makeLookup("pre", true));
        renderer.render(scene, cam);
        for (const [o, src, tmp] of lite) {
          o.geometry = src;
          const index = tmp.index;
          tmp.attributes = {};
          tmp.index = index;
          tmp.dispose();
        }
      }
      swap(makeLookup(mode, false));
      renderer.render(scene, cam);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, cur);
      return cur.slice();
    } finally {
      scene.traverse((o) => {
        if (o.__odpMaterial) {
          // (the counting materials are dropped WITHOUT dispose(): their programs stay in
          // three's cache, nothing recompiles at the next count)
          o.material = o.__odpMaterial;
          delete o.__odpMaterial;
        }
      });
      for (const o of hooked) {
        if (o.__odpOwnAfter) o.onAfterRender = o.__odpOwnAfter;
        else delete o.onAfterRender;
        delete o.__odpOwnAfter;
      }
      for (const [o, src, tmp] of tmpGeos) {
        o.geometry = src;
        const index = tmp.index;
        tmp.attributes = {};
        tmp.index = index;
        tmp.dispose(); // frees the temporary index buffer only
      }
      renderer.setOpaqueSort(sortOverride ?? gameSort);
      renderer.shadowMap.autoUpdate = shadowAuto;
      scene.background = bg;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ------------------------------------------------------------------ analysis
  const last = {};
  // One render per task: the bench's software renderer frees its per-frame memory only between
  // tasks (a dozen renders in one synchronous call get it OOM-killed).
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 30));
    if (window.gc) window.gc();
  };
  async function run(opts) {
    const px = count(opts);
    const draws = perDraw.map((d) => ({ ...d }));
    await settle();
    return { px, draws };
  }

  /** Full analysis of the current pose: base counts, then the requested variants. */
  async function analyze(spec = {}) {
    const shade = await run({ mode: "shade", perDraw: true });
    const raster = await run({ mode: "raster", perDraw: true });
    const id = await run({ mode: "id", perDraw: false });
    const skyRank = items.findIndex((it) => it.kind === "sky");
    const P = w * h;
    const owner = new Int32Array(P);
    const ownerBack = new Uint8Array(P);
    const visible = items.map(() => 0);
    const visibleBack = items.map(() => 0);
    let sky = 0, none = 0;
    for (let p = 0; p < P; p++) {
      const o = id.px[p * 4] + 256 * id.px[p * 4 + 1] - 1;
      owner[p] = o;
      ownerBack[p] = id.px[p * 4 + 2] > 127 ? 1 : 0;
      if (o < 0) none++;
      else {
        visible[o]++;
        if (ownerBack[p]) visibleBack[o]++;
        if (o === skyRank) sky++;
      }
    }
    // Shaded fragments per covered (non-sky) pixel: histogram + heat-map source.
    const hist = new Array(9).fill(0);
    for (let p = 0; p < P; p++) {
      const o = owner[p];
      if (o < 0 || o === skyRank) continue;
      const n = shade.px[p * 4] + shade.px[p * 4 + 1];
      hist[Math.min(8, n)]++;
    }
    last.shadePx = shade.px;
    last.owner = owner;
    last.skyRank = skyRank;
    const perItem = items.map((it, rank) => ({
      rank,
      raster: raster.draws[rank].front + raster.draws[rank].back,
      rasterBack: raster.draws[rank].back,
      footprint: raster.draws[rank].touched,
      shaded: shade.draws[rank].front + shade.draws[rank].back,
      shadedBack: shade.draws[rank].back,
      visible: visible[rank],
      visibleBack: visibleBack[rank],
    }));
    const sum = (pred, f) => perItem.reduce((s, d, i) => s + (pred(items[i]) ? f(d) : 0), 0);
    const group = (pred) => ({
      raster: sum(pred, (d) => d.raster),
      shaded: sum(pred, (d) => d.shaded),
      visible: sum(pred, (d) => d.visible),
      rasterBack: sum(pred, (d) => d.rasterBack),
      shadedBack: sum(pred, (d) => d.shadedBack),
      visibleBack: sum(pred, (d) => d.visibleBack),
      tris: items.reduce((s, it) => s + (pred(it) ? trisOf(it.geometry, it.object, it.group) : 0), 0),
      draws: items.reduce((s, it) => s + (pred(it) ? 1 : 0), 0),
    });
    const out = {
      pixels: P,
      skyPixels: sky,
      nonePixels: none,
      histogram: hist,
      // the game's own prepass (DIAG=prepass): depth-only fragments + draws
      gamePrepass: {
        draws: items.reduce((s, it) => s + (it.kind === "prepass" ? 1 : 0), 0),
        tris: items.reduce((s, it) => s + (it.kind === "prepass" ? trisOf(it.geometry, it.object, it.group) : 0), 0),
        depthFragments: shade.draws.reduce((s, d, i) => s + (items[i].kind === "prepass" ? d.pre : 0), 0),
      },
      all: group((it) => it.kind !== "sky" && it.kind !== "prepass"),
      map: group((it) => it.kind === "map"),
      decor: group((it) => it.kind === "decor"),
      backdrop: group((it) => it.kind === "backdrop"),
      other: group((it) => it.kind === "other"),
      perItem,
      variants: {},
    };
    // Variants: depth prepass, index orders, single-sided faces.
    const mapShaded = (r) => r.draws.reduce((s, d, i) => s + (items[i].kind === "map" ? d.front + d.back : 0), 0);
    const allShaded = (r) => r.draws.reduce((s, d, i) => s + (items[i].kind !== "sky" ? d.front + d.back : 0), 0);
    const mapPre = (r) => r.draws.reduce((s, d, i) => s + (items[i].kind === "map" ? d.pre : 0), 0);
    if (spec.prepass) {
      const r = await run({ mode: "shade", perDraw: true, prepass: true });
      out.variants.prepass = { mapShaded: mapShaded(r), allShaded: allShaded(r), prepassDepthFragments: mapPre(r), prepassTris: lastPrepassTris };
    }
    for (const area of spec.prepassLite ?? []) {
      const r = await run({ mode: "shade", perDraw: true, prepass: true, prepassMinArea: area });
      out.variants[`prepass>=${area}`] = { mapShaded: mapShaded(r), allShaded: allShaded(r), prepassDepthFragments: mapPre(r), prepassTris: lastPrepassTris };
    }
    for (const order of spec.orders ?? []) {
      const r = await run({ mode: "shade", perDraw: true, order });
      out.variants[`order:${order}`] = { mapShaded: mapShaded(r), allShaded: allShaded(r) };
    }
    if (spec.frontSide) {
      // Every double-sided map batch drawn FrontSide: fragments saved, and how many pixels change.
      const r = await run({ mode: "shade", perDraw: true, frontSide: new Set(["*"]) });
      const idr = await run({ mode: "id", perDraw: false, frontSide: new Set(["*"]) });
      let changed = 0;
      for (let p = 0; p < P; p++) if (idr.px[p * 4] !== id.px[p * 4] || idr.px[p * 4 + 1] !== id.px[p * 4 + 1] || idr.px[p * 4 + 2] !== id.px[p * 4 + 2]) changed++;
      out.variants.frontSideAll = { mapShaded: mapShaded(r), allShaded: allShaded(r), changedPixels: changed };
    }
    return out;
  }

  /** PNG heat map of the last analysis (shaded fragments per pixel; sky = black). */
  function heatmap() {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    const ramp = [[0, 0, 0], [40, 70, 160], [40, 170, 90], [230, 200, 40], [240, 120, 30], [220, 30, 30], [200, 0, 200], [255, 255, 255]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (h - 1 - y) * w + x; // GL rows are bottom-up
        const q = (y * w + x) * 4;
        const o = last.owner[p];
        const n = o < 0 || o === last.skyRank ? 0 : last.shadePx[p * 4] + last.shadePx[p * 4 + 1];
        const col = ramp[Math.min(ramp.length - 1, n)];
        img.data[q] = col[0];
        img.data[q + 1] = col[1];
        img.data[q + 2] = col[2];
        img.data[q + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  // ------------------------------------------------------------------ scenarios
  /**
   * Opaque sort of the real frame: "game" (the game's own — Givre: frontToBackOpaqueSort, bounding
   * sphere CENTRE depth), "near" (same, but by the NEAREST point of the bounding sphere: z − r).
   */
  function setSort(kind) {
    const game = gameSort;
    if (kind === "near") {
      const radius = (it) => {
        const s = it.object.boundingSphere ?? it.geometry.boundingSphere;
        return s ? s.radius * it.object.matrixWorld.getMaxScaleOnAxis() : 0;
      };
      const near = (a, b) => {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
        const za = a.z - radius(a), zb = b.z - radius(b);
        if (za !== zb) return za - zb;
        return a.id - b.id;
      };
      sortOverride = near;
      renderer.setOpaqueSort(near);
    } else if (kind === "double") {
      // Map batches: the double-sided ones (walls, floors, roofs: the big occluders) before the
      // single-sided solids (crates, posts, slabs), front to back inside each class.
      const front = (it) => (it.material.side === FrontSide && kindOf(it.object) === "map" ? 1 : 0);
      const double = (a, b) => {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
        const fa = front(a), fb = front(b);
        if (fa !== fb) return fa - fb;
        if (a.z !== b.z) return a.z - b.z;
        return a.id - b.id;
      };
      sortOverride = double;
      renderer.setOpaqueSort(double);
    } else {
      sortOverride = null;
      renderer.setOpaqueSort(game);
    }
    return kind;
  }

  /**
   * Emulates a FINER grid split of the map batches: each batch is cut into sx × sz sub-cells of
   * its own bounding box (triangle centroid → sub-cell), each sub-batch a Mesh of its own (same
   * material, shared vertex buffers, own index + bounding sphere): three culls and sorts them
   * exactly as real batches. Returns the number of meshes; splitMap(0) restores.
   */
  let splitState = null;
  function splitMap(sx, sz) {
    if (splitState) {
      for (const [batch, parts] of splitState) {
        batch.visible = true;
        for (const part of parts) {
          part.removeFromParent();
          const index = part.geometry.index;
          part.geometry.attributes = {};
          part.geometry.index = index;
          part.geometry.dispose();
        }
      }
      splitState = null;
    }
    if (!sx) return 0;
    splitState = new Map();
    let meshes = 0;
    const merged = scene.getObjectByName("givre_01_merged");
    for (const batch of [...merged.children]) {
      const geo = batch.geometry;
      if (!geo.index) continue;
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const c = centroids(geo, geo.index);
      const n = geo.index.count / 3;
      const cellOf = (t) => {
        const fx = (c[t * S] - bb.min.x) / Math.max(1e-6, bb.max.x - bb.min.x);
        const fz = (c[t * S + 2] - bb.min.z) / Math.max(1e-6, bb.max.z - bb.min.z);
        return Math.min(sz - 1, Math.floor(fz * sz)) * sx + Math.min(sx - 1, Math.floor(fx * sx));
      };
      const lists = new Map();
      for (let t = 0; t < n; t++) {
        const k = cellOf(t);
        let l = lists.get(k);
        if (!l) lists.set(k, (l = []));
        l.push(t);
      }
      const parts = [];
      const src = geo.index.array;
      for (const tris of lists.values()) {
        const dst = new src.constructor(tris.length * 3);
        tris.forEach((t, i) => {
          dst[i * 3] = src[t * 3];
          dst[i * 3 + 1] = src[t * 3 + 1];
          dst[i * 3 + 2] = src[t * 3 + 2];
        });
        const g2 = new geo.constructor();
        for (const name of Object.keys(geo.attributes)) g2.setAttribute(name, geo.getAttribute(name));
        g2.setIndex(new geo.index.constructor(dst, 1));
        // bounding sphere of the sub-batch's own vertices
        const pos = geo.getAttribute("position");
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < dst.length; i++) {
          const v = dst[i];
          const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
          if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
        g2.boundingBox = bb.clone().set(bb.min.clone().set(minX, minY, minZ), bb.max.clone().set(maxX, maxY, maxZ));
        g2.boundingSphere = (geo.boundingSphere ?? (geo.computeBoundingSphere(), geo.boundingSphere)).clone();
        g2.boundingBox.getCenter(g2.boundingSphere.center);
        let r2 = 0;
        for (let i = 0; i < dst.length; i++) {
          const v = dst[i];
          const dx = pos.getX(v) - g2.boundingSphere.center.x, dy = pos.getY(v) - g2.boundingSphere.center.y, dz = pos.getZ(v) - g2.boundingSphere.center.z;
          r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
        }
        g2.boundingSphere.radius = Math.sqrt(r2);
        const part = new batch.constructor(g2, batch.material);
        part.name = `${batch.name}_split`;
        part.matrixAutoUpdate = false;
        part.matrix.copy(batch.matrix);
        part.castShadow = false; // (the shadow map is baked / cached: unchanged)
        part.receiveShadow = batch.receiveShadow;
        part.raycast = () => {};
        batch.parent.add(part);
        part.updateMatrixWorld(true);
        parts.push(part);
        meshes++;
      }
      batch.visible = false;
      splitState.set(batch, parts);
    }
    return meshes;
  }

  window.__odp = { pose, capture, analyze, heatmap, setSort, splitMap, size: [w, h] };
  return [w, h];
}
