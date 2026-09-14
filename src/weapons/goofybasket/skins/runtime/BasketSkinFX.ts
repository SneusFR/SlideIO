import * as THREE from "three";

export type BasketSkinFXKind = "electric" | "solar";
export type BasketSkinFXQuality = "low" | "high";
export interface BasketSkinFX {
  root: THREE.Group;
  update(timeSeconds: number, charge01: number): void;
  dispose(): void;
}

// These meshes are cosmetic overlays. They do not replace, deform or own the ball.
// All geometry uses a unit ball; the returned root supplies the caller's radius.
const NOISE = /* glsl */ `
float fxHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float fxNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fxHash(i), fxHash(i+vec3(1,0,0)), f.x),
                 mix(fxHash(i+vec3(0,1,0)), fxHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(fxHash(i+vec3(0,0,1)), fxHash(i+vec3(1,0,1)), f.x),
                 mix(fxHash(i+vec3(0,1,1)), fxHash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fxFlow(vec3 p) {
  float n = 0.57 * fxNoise(p);
  p = p.yzx * 2.03 + vec3(7.1, 3.2, 5.4);
  n += 0.28 * fxNoise(p);
  n += 0.15 * fxNoise(p.zxy * 2.01 + 4.7);
  return n;
}
`;

const VERTEX_HEADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform float uCharge;
uniform float uSeed;
varying vec3 vLocal;
varying vec3 vNormalView;
varying vec3 vViewDirection;
`;
const FRAGMENT_HEADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uCharge;
uniform float uSeed;
varying vec3 vLocal;
varying vec3 vNormalView;
varying vec3 vViewDirection;
// Additive radiance fades to zero in fog; it must not add the fog's color.
float fxFogVisibility() {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      return exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      return 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #else
    return 1.0;
  #endif
}
`;
const OUTPUT = /* glsl */ `
  gl_FragColor.a *= fxFogVisibility();
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const SHELL_VERTEX = VERTEX_HEADER + NOISE + /* glsl */ `
uniform float uLayer;
uniform float uSolar;
void main() {
  vec3 direction = normalize(position);
  vec3 flow = direction * 3.2 + vec3(uTime * 0.13, -uTime * 0.22, uSeed);
  // Broad, slowly moving lobes, not a uniformly inflated glass surface.
  float displacement = (fxNoise(flow) - 0.46) * 0.115 * uSolar;
  displacement += 0.014 * sin(direction.y * 7.0 + uTime * 0.7 + uSeed) * uSolar;
  vec3 p = position + direction * displacement;
  vLocal = direction;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vNormalView = normalMatrix * direction;
  vViewDirection = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const SHELL_FRAGMENT = FRAGMENT_HEADER + NOISE + /* glsl */ `
uniform float uLayer;
uniform float uSolar;
void main() {
  #include <logdepthbuf_fragment>
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDirection)));
  float rim = 1.0 - facing;
  if (rim < 0.19) discard;
  vec3 p = vLocal;
  float drift = uTime * 0.16 + uSeed;
  float c = cos(drift), s = sin(drift);
  p.xz = mat2(c,-s,s,c) * p.xz;
  vec3 flow = p * 4.0 + vec3(0.0, -uTime * 0.33, uSeed * 0.7);
  vec3 warp = vec3(fxNoise(flow + 5.1), fxNoise(flow.yzx + 8.7), fxNoise(flow.zxy + 2.4));
  float clouds = fxFlow(flow + (warp - 0.5) * 1.6);
  float veins = exp(-23.0 * abs(clouds - 0.52));
  float vapor = smoothstep(0.28, 0.66, clouds);
  // Both boundaries vary with the advected density. Empty patches remain empty
  // instead of connecting into the milky Fresnel ring of a transparent sphere.
  float inner = mix(0.44,0.30,uLayer) - (clouds-0.45)*0.30;
  float band = smoothstep(inner,0.83,rim);
  band *= 1.0-smoothstep(0.83+clouds*0.15,0.997,rim);
  float plasma = smoothstep(0.24,0.62,clouds) * (0.50+0.75*veins);
  float heat = clamp(vapor*0.65+veins*0.60,0.0,1.0);
  // The solar overlay uses moderate linear radiance and bypasses material tone
  // mapping to preserve amber saturation. The game's renderer remains unchanged.
  vec3 gold = mix(vec3(1.0,0.065,0.0003),vec3(1.0,0.36,0.004),heat*heat);
  vec3 cyan = vec3(0.025,1.10,2.4);
  vec3 color = mix(cyan,gold,uSolar);
  float electricAlpha = band*0.16*(0.35+0.65*vapor);
  float solarAlpha = band*plasma*mix(0.88,0.72,uLayer)*(1.0+0.22*uCharge);
  float alpha = mix(electricAlpha,solarAlpha,uSolar);
  if(alpha<0.012) discard;
  gl_FragColor = vec4(color, alpha);
` + OUTPUT + `}
`;

const RIBBON_VERTEX = VERTEX_HEADER + /* glsl */ `
uniform float uSolar;
attribute float aPhase;
varying vec2 vRibbonUV;
varying float vPhase;
void main() {
  float flutter = sin(uv.x*7.0 + aPhase + uTime*0.65)*0.013;
  flutter += sin(uv.x*11.0 - aPhase*0.7 - uTime*0.38)*0.009;
  vec3 p = position + normalize(position)*flutter*sin(uv.x*3.14159265)*uSolar;
  vLocal = p;
  vRibbonUV = uv;
  vPhase = aPhase;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vNormalView = normalMatrix * normalize(p);
  vViewDirection = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const RIBBON_FRAGMENT = FRAGMENT_HEADER + NOISE + /* glsl */ `
uniform float uSolar;
varying vec2 vRibbonUV;
varying float vPhase;
void main() {
  #include <logdepthbuf_fragment>
  float across = 1.0 - abs(vRibbonUV.y * 2.0 - 1.0);
  float edge = smoothstep(0.0,0.52,across);
  float core = pow(across, 7.0);
  float ends = smoothstep(0.0,0.08,vRibbonUV.x) * (1.0-smoothstep(0.90,1.0,vRibbonUV.x));
  float wave = sin(uTime * (3.1 + vPhase * 0.31) + vPhase * 9.1);
  float flash = pow(max(0.0,wave), 12.0);
  float flicker = 0.80 + 0.20 * sin(uTime * 73.0 + vPhase * 19.0);
  float electric = (0.12 + 0.88 * flash) * flicker;
  float flow = fxFlow(vLocal * 6.0 + vec3(vPhase, -uTime * 0.45, uSeed));
  float solar = (0.16 + 0.84 * smoothstep(0.22,0.65,flow));
  float alpha = edge * ends * mix(electric,solar * 0.92,uSolar) * (0.85 + 0.15*uCharge);
  vec3 cool = mix(vec3(0.025,1.05,3.0), vec3(1.45,2.2,2.7),core);
  vec3 warm = mix(vec3(1.0,0.09,0.0005), vec3(1.0,0.46,0.012),core);
  gl_FragColor = vec4(mix(cool,warm,uSolar) * (1.0 + 0.35*uCharge), alpha);
` + OUTPUT + `}
`;

const EMBER_VERTEX = VERTEX_HEADER + /* glsl */ `
attribute vec3 aAnchor;
attribute float aPhase;
attribute float aSize;
varying vec2 vEmberUV;
varying float vLife;
void main() {
  float life = fract(uTime * 0.19 + aPhase);
  vec3 p = aAnchor * (1.018 + 0.24 * life);
  p.y += life * life * 0.065;
  vLife = sin(life * 3.14159265);
  vEmberUV = uv;
  vLocal = p;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  // Camera-facing quads inherit the radius and uniform parent scale, no camera API.
  vec2 scale = vec2(length(modelViewMatrix[0].xyz),length(modelViewMatrix[1].xyz));
  mvPosition.xy += position.xy * aSize * scale;
  vNormalView = vec3(0,0,1);
  vViewDirection = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const EMBER_FRAGMENT = FRAGMENT_HEADER + /* glsl */ `
varying vec2 vEmberUV;
varying float vLife;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vEmberUV - 0.5) * 2.0;
  float d = length(p);
  float alpha = (1.0-smoothstep(0.1,1.0,d)) * vLife*vLife * (0.26+uCharge*0.10);
  if(alpha<0.008) discard;
  gl_FragColor = vec4(1.0,0.24,0.004,alpha);
` + OUTPUT + `}
`;

function randomGenerator(seed: number): () => number {
  let value = (Math.trunc(seed) ^ 0x6d2b79f5) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let x = Math.imul(value ^ (value >>> 15), value | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function ribbonGeometry(solar: boolean, high: boolean, random: () => number): THREE.BufferGeometry {
  const count = solar ? (high ? 5 : 3) : (high ? 5 : 3);
  const steps = solar ? (high ? 34 : 22) : (high ? 15 : 10);
  const positions: number[] = [], uvs: number[] = [], phases: number[] = [], indices: number[] = [];
  const axis = new THREE.Vector3(), tangent = new THREE.Vector3(), side = new THREE.Vector3();
  const point = new THREE.Vector3(), normal = new THREE.Vector3(), across = new THREE.Vector3();
  const rotation = random() * Math.PI * 2;
  for (let arc = 0; arc < count; arc++) {
    // Distributed over the sphere: only a few short arcs are visible from one view.
    const y = 1 - 2 * (arc + 0.5) / count;
    const azimuth = arc * 2.399963229728653 + rotation;
    axis.set(Math.cos(azimuth)*Math.sqrt(1-y*y),y,Math.sin(azimuth)*Math.sqrt(1-y*y));
    tangent.set(random()-0.5,random()-0.5,random()-0.5).addScaledVector(axis,-axis.dot(tangent)).normalize();
    if (tangent.lengthSq() < 0.1) tangent.set(1,0,0).cross(axis).normalize();
    side.crossVectors(axis,tangent).normalize();
    const phase = random() * 4, span = solar ? 1.00 + random()*0.52 : 0.38 + random()*0.23;
    const halfWidth = solar ? 0.017 : 0.0075;
    const offset = positions.length/3;
    for (let i = 0; i <= steps; i++) {
      const u = i/steps, angle = (u-0.5)*span;
      const jitter = solar ? Math.sin(u*Math.PI*2+phase)*0.027 : (random()-0.5)*0.09*Math.sin(u*Math.PI);
      normal.copy(axis).multiplyScalar(Math.cos(angle)).addScaledVector(tangent,Math.sin(angle)).addScaledVector(side,jitter).normalize();
      const height = solar ? 1.018 + Math.sin(u*Math.PI)**2*(0.085+0.013*phase) : 1.018 + Math.sin(u*Math.PI)*0.032;
      point.copy(normal).multiplyScalar(height);
      across.crossVectors(normal,tangent).normalize();
      const width = halfWidth * Math.max(0.15,Math.sin(u*Math.PI));
      for (const sign of [-1,1]) {
        positions.push(point.x+across.x*width*sign,point.y+across.y*width*sign,point.z+across.z*width*sign);
        uvs.push(u,(sign+1)/2);phases.push(phase);
      }
      if (i<steps) {
        const a=offset+i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute("aPhase",new THREE.Float32BufferAttribute(phases,1));
  geometry.setIndex(indices);geometry.computeBoundingSphere();
  if(solar && geometry.boundingSphere) geometry.boundingSphere.radius+=0.03;
  return geometry;
}

function emberGeometry(random: () => number): THREE.BufferGeometry {
  const positions:number[]=[],uvs:number[]=[],anchors:number[]=[],phases:number[]=[],sizes:number[]=[],indices:number[]=[];
  for(let i=0;i<6;i++) {
    const y=random()*2-1,a=random()*Math.PI*2,r=Math.sqrt(1-y*y),anchor=[Math.cos(a)*r,y,Math.sin(a)*r];
    const phase=random(),size=0.005+random()*0.004;
    for(const [x,z] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
      positions.push(x,z,0);uvs.push((x+1)/2,(z+1)/2);anchors.push(...anchor);phases.push(phase);sizes.push(size);
    }
    const n=i*4;indices.push(n,n+1,n+2,n+1,n+3,n+2);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute("aAnchor",new THREE.Float32BufferAttribute(anchors,3));
  geometry.setAttribute("aPhase",new THREE.Float32BufferAttribute(phases,1));
  geometry.setAttribute("aSize",new THREE.Float32BufferAttribute(sizes,1));
  geometry.setIndex(indices);geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),1.40);
  return geometry;
}

/**
 * Attach root to the centered ball instance, with radius in that instance's LOCAL
 * geometry coordinates (0.125 for the original GoofyBasket GLB). The ball's own
 * .88 / world scale is inherited; do not apply it again here. No RAF or renderer.
 * Low: electric 1 / solar 2 draws. High: electric 2 / solar 4 draws.
 */
export function createBasketSkinFX(
  kind: BasketSkinFXKind,
  radius: number,
  quality: BasketSkinFXQuality,
  seed: number,
): BasketSkinFX {
  if(kind!=="electric" && kind!=="solar") throw new RangeError("Unknown basket skin FX kind");
  if(!Number.isFinite(radius) || radius<=0) throw new RangeError("FX radius must be finite and positive");
  if(quality!=="low" && quality!=="high") throw new RangeError("Unknown basket skin FX quality");
  if(!Number.isFinite(seed)) throw new RangeError("FX seed must be finite");
  const high=quality==="high",solar=kind==="solar",random=randomGenerator(seed);
  const root=new THREE.Group();root.name=`GoofyBasketFX_${kind}`;root.scale.setScalar(radius);
  const materials:THREE.ShaderMaterial[]=[],geometries:THREE.BufferGeometry[]=[];
  let disposed=false;
  function add(name:string,geometry:THREE.BufferGeometry,vertexShader:string,fragmentShader:string,layer=0,ribbon=false):void {
    const material=new THREE.ShaderMaterial({
      name,vertexShader,fragmentShader,
      uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{
        uTime:{value:0},uCharge:{value:0},uSeed:{value:random()*31},uLayer:{value:layer},uSolar:{value:solar?1:0},
      }]),
      transparent:true,blending:THREE.AdditiveBlending,depthTest:true,depthWrite:false,
      side:ribbon?THREE.DoubleSide:THREE.FrontSide,fog:true,toneMapped:!solar,
    });
    material.forceSinglePass=true;
    const mesh=new THREE.Mesh(geometry,material);mesh.name=name;mesh.castShadow=false;mesh.receiveShadow=false;
    mesh.raycast=()=>{};
    root.add(mesh);materials.push(material);geometries.push(geometry);
  }
  function shell(scale:number,layer:number):void {
    const geometry=new THREE.SphereGeometry(scale,high?44:28,high?28:18);
    geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),scale+0.080);
    add(`${kind}_radiance_${layer}`,geometry,SHELL_VERTEX,SHELL_FRAGMENT,layer);
  }
  if(solar) {
    shell(1.115,0);
    if(high) shell(1.028,1);
    add("solar_filaments",ribbonGeometry(true,high,random),RIBBON_VERTEX,RIBBON_FRAGMENT,0,true);
    if(high) add("solar_embers",emberGeometry(random),EMBER_VERTEX,EMBER_FRAGMENT,0,true);
  } else {
    if(high) shell(1.05,0);
    add("electric_arcs",ribbonGeometry(false,high,random),RIBBON_VERTEX,RIBBON_FRAGMENT,0,true);
  }
  root.userData.skinFX={kind,quality,drawCalls:root.children.length,localRadius:radius};
  return {
    root,
    update(timeSeconds:number,charge01:number):void {
      if(disposed) return;
      const time=Number.isFinite(timeSeconds)?Math.max(0,timeSeconds):0;
      const charge=Number.isFinite(charge01)?THREE.MathUtils.clamp(charge01,0,1):0;
      for(const material of materials) {
        material.uniforms.uTime.value=time;
        material.uniforms.uCharge.value=charge;
      }
    },
    dispose():void {
      if(disposed) return;disposed=true;
      root.removeFromParent();root.clear();
      for(const geometry of geometries) geometry.dispose();
      for(const material of materials) material.dispose();
    },
  };
}
