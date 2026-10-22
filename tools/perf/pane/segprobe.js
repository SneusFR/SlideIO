// GPU time of each pass of a game frame (page realm, after probe-autopilot.js with
// __bz.mode = "off": two TIME_ELAPSED queries cannot overlap). The frame's WebGL is cut at every
// draw-framebuffer binding (shadow map, world target, MSAA resolve, output, canvas…) into
// consecutive TIME_ELAPSED queries. A spike shows in the pass that holds it — a heavy draw, an
// upload, or a stall INSIDE the command stream (the GPU process compiling a shader variant: the
// GPU idles inside the query).
//   __sp.on = true / false; per game frame: __sp.frames[k] = { t, segs: [[fbId, ms|null], …] }
//   __sp.fbInfo: fbId → attachments (seen once)
(() => {
  if (window.__sp) return "sp already";
  const bz = window.__bz;
  if (!bz || !bz.T) return "sp needs __bz with a timer";
  const gl = bz.gl, T = bz.T;
  const P = WebGL2RenderingContext.prototype;
  const SP = (window.__sp = { on: false, frames: [], pending: [], fbInfo: new Map(), err: null, disjoint: 0 });
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o) return 0; let v = ids.get(o); if (!v) { v = nextId++; ids.set(o, v); } return v; };
  const origBegin = P.beginQuery, origEnd = P.endQuery, origBind = P.bindFramebuffer;
  const getQP = P.getQueryParameter, del = P.deleteQuery, mk = P.createQuery, getP = P.getParameter, getFAP = P.getFramebufferAttachmentParameter;
  let cur = null; // { t, segs, q }
  const open = (fb) => {
    const q = mk.call(gl);
    origBegin.call(gl, T.TIME_ELAPSED_EXT, q);
    const seg = [fb, null];
    cur.segs.push(seg);
    SP.pending.push({ q, seg });
    cur.q = q;
  };
  const close = () => { if (cur && cur.q) { origEnd.call(gl, T.TIME_ELAPSED_EXT); cur.q = null; } };
  P.bindFramebuffer = function (target, fb) {
    if (this !== gl || !cur || !(target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER)) return origBind.call(this, target, fb);
    close();
    const r = origBind.call(this, target, fb);
    const id = idOf(fb);
    if (fb && !SP.fbInfo.has(id)) {
      try {
        const kind = (att) => { const ty = getFAP.call(gl, gl.DRAW_FRAMEBUFFER, att, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE); return ty === gl.TEXTURE ? "tex" : ty === gl.RENDERBUFFER ? "rb" : "-"; };
        SP.fbInfo.set(id, `c0:${kind(gl.COLOR_ATTACHMENT0)} c1:${kind(gl.COLOR_ATTACHMENT1)} d:${kind(gl.DEPTH_ATTACHMENT)} ds:${kind(gl.DEPTH_STENCIL_ATTACHMENT)}`);
      } catch (e) { SP.fbInfo.set(id, "?"); }
    }
    open(id);
    return r;
  };
  const poll = () => {
    if (!SP.pending.length) return;
    if (getP.call(gl, T.GPU_DISJOINT_EXT)) { for (const p of SP.pending) del.call(gl, p.q); SP.pending.length = 0; SP.disjoint++; return; }
    let i = 0;
    for (; i < SP.pending.length; i++) {
      const p = SP.pending[i];
      if (!getQP.call(gl, p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      p.seg[1] = getQP.call(gl, p.q, gl.QUERY_RESULT) / 1e6;
      del.call(gl, p.q);
    }
    if (i) SP.pending.splice(0, i);
  };
  const prevRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return prevRaf.call(window, function (t) {
      if (!SP.on) return cb(t);
      cur = { t, segs: [], q: null };
      try { cb(t); } finally {
        close();
        if (cur.segs.length) {
          SP.frames.push({ t, segs: cur.segs });
          if (SP.frames.length > 40000) SP.frames.splice(0, 10000);
        }
        cur = null;
        try { poll(); } catch (e) { SP.err = String(e); }
      }
    });
  };
  return "sp ready";
})();
