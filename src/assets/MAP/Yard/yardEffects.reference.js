import { AnimationMixer, Vector3 } from 'three';

/** Map-local visual animation and interaction hooks. No networking or input listeners. */
export function createYardEffects({ yard, world, RAPIER, onHazard, onInteract } = {}) {
  if (!yard?.root || !world || !RAPIER) throw new TypeError('yard, world and RAPIER are required');
  const mixer = new AnimationMixer(yard.root);
  for (const clip of yard.animations ?? []) mixer.clipAction(clip).play();
  const water = yard.root.getObjectByName('ACID_LIQUID_SURFACE');
  if (!water?.isMesh) throw new Error('Acid surface is missing from this map export');
  const material = water.material;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const clock = { value: 0 };
  water.castShadow = false;
  // Opaque liquid avoids transparent sorting and scene-copy/refraction passes.
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    shader.uniforms.uYardTime = clock;
    shader.vertexShader = 'uniform float uYardTime; varying vec3 vYardWater;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float wave = sin(position.x * 1.7 + uYardTime * 1.6)
                 * cos((position.y + position.z) * 1.3 - uYardTime);
      transformed += objectNormal * wave * 0.028;
      vYardWater = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `);
    shader.fragmentShader = 'uniform float uYardTime; varying vec3 vYardWater;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 flow = vYardWater.xz;
      float ripple = 0.52 * sin(flow.x * 0.88 + flow.y * 0.34 + uYardTime * 0.7 + sin(flow.y * 0.44 - uYardTime * 0.4))
                   + 0.30 * sin(flow.y * 1.24 - flow.x * 0.14 - uYardTime * 0.65)
                   + 0.18 * sin((flow.x + flow.y) * 1.96 + uYardTime);
      float glint = smoothstep(0.72, 0.96, ripple);
      diffuseColor.rgb *= 0.88 + 0.12 * ripple;
      diffuseColor.rgb += vec3(0.15, 0.22, 0.065) * glint;
    `);
  };
  material.customProgramCacheKey = () => 'yard-acid-waves-v1';
  material.needsUpdate = true;
  let elapsed = 0, nextHazardTime = 0, disposed = false;
  const eye = new Vector3(), target = new Vector3(), direction = new Vector3();
  const hazards = yard.metadata.hazards ?? [];
  const interactables = yard.metadata.interactables ?? [];
  const xyz = p => Array.isArray(p) ? p : [p.x, p.y, p.z];

  function nearby(playerFeet, playerCollider) {
    if (disposed || !playerFeet) return null;
    const p = xyz(playerFeet);
    eye.set(p[0], p[1] + 1.65, p[2]);
    let nearest = null, best = Infinity;
    for (const item of interactables) {
      target.fromArray(item.position);
      const distance = eye.distanceTo(target);
      if (distance > item.radius || distance >= best) continue;
      direction.subVectors(target, eye).normalize();
      const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z },
        { x: direction.x, y: direction.y, z: direction.z });
      const hit = item.requiresLineOfSight
        ? world.castRay(ray, Math.max(0, distance - 0.03), true, undefined, undefined, playerCollider)
        : null;
      if (!hit) { nearest = item; best = distance; }
    }
    return nearest;
  }

  return {
    mixer, water,
    update(deltaSeconds, playerFeet) {
      if (disposed) return;
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be finite and nonnegative');
      const dt = Math.min(deltaSeconds, 0.1);
      elapsed += dt; clock.value = elapsed; mixer.update(dt);
      if (!playerFeet || elapsed < nextHazardTime) return;
      const p = xyz(playerFeet);
      for (const hazard of hazards) {
        if (p.every((v, i) => v >= hazard.min[i] && v <= hazard.max[i])) {
          nextHazardTime = elapsed + 0.8;
          onHazard?.(hazard);
          break;
        }
      }
    },
    nearby,
    interact(playerFeet, playerCollider) {
      const item = nearby(playerFeet, playerCollider);
      if (!item) return false;
      onInteract?.(item);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.stopAllAction(); mixer.uncacheRoot(yard.root);
      material.onBeforeCompile = previousCompile;
      material.customProgramCacheKey = previousKey;
      material.needsUpdate = true;
    },
  };
}
