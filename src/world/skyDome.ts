import * as THREE from "three";

/**
 * Render order of the Yard / Jungle sky domes: after every opaque object of
 * the world (the highest other render order is 999, the ragdoll debug
 * lines). Givre's dome uses the same value (GIVRE_SKY_RENDER_ORDER).
 */
export const SKY_DOME_RENDER_ORDER = 10000;

/**
 * PERF (GPU): a sky dome drawn LAST among the opaques, on the far plane,
 * with the depth test — the GPU only colours the sky pixels nothing hides
 * (indoors, under a roof: almost none). Drawn first ("behind everything"),
 * it filled the whole screen every frame before the map covered most of
 * it: the same 1.7 ms of a 15 ms frame the Givre sky cost on an Intel Iris
 * Xe at 1920 × 928 (GivreSky). Same image: the dome writes no depth either
 * way, every opaque writes depth (the sky still lands only where nothing
 * was drawn), and every material that does not is transparent — drawn
 * after the dome, as before.
 *
 * The dome goes in its OWN group: a Group's render order is the "group
 * order" of its children, sorted before their own — the dome stays after
 * every opaque whatever other groups use, while the sky's transparent
 * layers (sun, clouds, stars…) keep their place among the transparents.
 */
export function drawDomeLast(dome: THREE.Mesh): THREE.Group {
  const material = dome.material as THREE.Material;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\n\tgl_Position.z = gl_Position.w; // on the far plane: behind any depth written",
    );
  };
  dome.renderOrder = SKY_DOME_RENDER_ORDER;
  const layer = new THREE.Group();
  layer.name = "sky_dome";
  layer.renderOrder = SKY_DOME_RENDER_ORDER;
  layer.add(dome);
  return layer;
}
