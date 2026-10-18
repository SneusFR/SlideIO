/**
 * Skips the texParameteri calls that would not change anything.
 *
 * three.js re-applies a texture's sampler parameters (wrap S / T, min / mag
 * filter: four texParameteri) at EVERY upload of that texture, and every
 * skinned mesh re-uploads its bone texture every frame it is drawn: with 8
 * bots in view, ~70 calls per frame that set the values the texture already
 * has. Each WebGL call is validated in the page, then decoded and replayed
 * by the browser's GPU process (ANGLE / D3D11 on Windows), which at 240 Hz
 * has 4 ms per frame for ALL of the game's GL work.
 *
 * The context's texParameteri remembers, per texture object, the last value
 * set for each parameter (bindings tracked through activeTexture /
 * bindTexture) and drops a call that repeats it. Nothing else changes: the
 * first set, and every real change, still goes through; texParameterf (float
 * parameters: anisotropy, LOD) forgets the remembered value of its pname.
 */
export function installTexParamDedupe(gl: WebGL2RenderingContext): void {
  const TARGETS: number[] = [gl.TEXTURE_2D, gl.TEXTURE_CUBE_MAP, gl.TEXTURE_3D, gl.TEXTURE_2D_ARRAY];
  /** Real unit count: activeTexture beyond it is an error that changes nothing. */
  const MAX_UNITS = Math.max(1, Math.min(256, gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number));
  const params = new WeakMap<WebGLTexture, Map<number, number>>();
  /**
   * Texture bound per (unit, target): index = unit * 4 + target index. Only
   * bindings made through the wrapper are known — an unknown one (null)
   * never skips anything — and the active unit is read once at install, so
   * a known binding is always the real one.
   */
  const binding: (WebGLTexture | null)[] = new Array(MAX_UNITS * TARGETS.length).fill(null);
  let unit = (gl.getParameter(gl.ACTIVE_TEXTURE) as number) - gl.TEXTURE0;
  if (!(unit >= 0 && unit < MAX_UNITS)) unit = 0;

  const activeTexture = gl.activeTexture.bind(gl);
  const bindTexture = gl.bindTexture.bind(gl);
  const texParameteri = gl.texParameteri.bind(gl);
  const texParameterf = gl.texParameterf.bind(gl);

  const boundTexture = (target: number): WebGLTexture | null => {
    const t = TARGETS.indexOf(target);
    return t >= 0 ? binding[unit * TARGETS.length + t] : null;
  };

  gl.activeTexture = (texture: number): void => {
    const u = texture - gl.TEXTURE0;
    // An invalid unit is an error for WebGL and leaves the active unit as is.
    if (u >= 0 && u < MAX_UNITS) unit = u;
    activeTexture(texture);
  };
  gl.bindTexture = (target: number, texture: WebGLTexture | null): void => {
    const t = TARGETS.indexOf(target);
    if (t >= 0) binding[unit * TARGETS.length + t] = texture;
    bindTexture(target, texture);
  };
  gl.texParameteri = (target: number, pname: number, param: number): void => {
    const texture = boundTexture(target);
    if (!texture) {
      texParameteri(target, pname, param);
      return;
    }
    let set = params.get(texture);
    if (!set) {
      set = new Map();
      params.set(texture, set);
    }
    if (set.get(pname) === param) return;
    texParameteri(target, pname, param);
    set.set(pname, param);
  };
  gl.texParameterf = (target: number, pname: number, param: number): void => {
    const texture = boundTexture(target);
    if (texture) params.get(texture)?.delete(pname);
    texParameterf(target, pname, param);
  };

  // A restored context starts from scratch (unit 0, nothing bound, new
  // texture objects): the bookkeeping follows.
  (gl.canvas as HTMLCanvasElement).addEventListener?.("webglcontextrestored", () => {
    unit = 0;
    binding.fill(null);
  });
}
