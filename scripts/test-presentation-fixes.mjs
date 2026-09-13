/**
 * Presentation fixes regression (no WebGL):
 *   - Brick Maul Equip plays at BRICKMAUL_TIMING.equipTimeScale on the TP
 *     controller (effective duration = BRICKMAUL_TIMING.equip);
 *   - Brick Maul inspection is LAYERED on the remote avatar: upper-body
 *     clip over the lower-body locomotion of the real state (the legs keep
 *     running; the inspection survives a state change; an attack replaces
 *     it; it ends by itself and hands back to the full locomotion);
 *   - HexSniper TP idle grip = TP_Aim_HexSniper (FP parity) and every armed
 *     composite carries the SAME constant Weapon_R / arm grip.
 * Run: node scripts/test-presentation-fixes.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {clone} from 'three/examples/jsm/utils/SkeletonUtils.js';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/').replace(/\/$/,'');
globalThis.self=globalThis;
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
THREE.TextureLoader.prototype.load=function(u,done){const tex=new THREE.Texture();queueMicrotask(()=>done?.(tex));return tex;};
THREE.ImageBitmapLoader.prototype.load=function(u,done){queueMicrotask(()=>done?.({width:1,height:1,close(){}}));};
const read=async file=>{const b=fs.readFileSync(file);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
const server=await createServer({root:project,configFile:false,server:{middlewareMode:true},appType:'custom'});
try{
 GLTFLoader.prototype.loadAsync=async function(url){const name=url.split('/').pop().split('?')[0];const dir=/BrickMaul/.test(name)?'src/assets/brickmaul/':'src/assets/potato/';return read(project+'/'+dir+name);};
 const {loadCharacterAsset}=await server.ssrLoadModule('/src/characters/PotatoCharacter.ts');
 const {RemotePlayerAnimationController}=await server.ssrLoadModule('/src/network/remote/RemotePlayerAnimationController.ts');
 const {BRICKMAUL_TIMING}=await server.ssrLoadModule('/src/weapons/brickmaul/BrickMaulProfile.ts');
 const asset=await loadCharacterAsset();
 const bone=n=>n.slice(0,n.lastIndexOf('.'));

 // ---- 1. Equip timing ----
 assert.ok(BRICKMAUL_TIMING.equipTimeScale>1,'equip is sped up');
 assert.ok(Math.abs(BRICKMAUL_TIMING.equip-0.65/BRICKMAUL_TIMING.equipTimeScale)<1e-9,'effective equip duration derives from the rate');
 const model=clone(asset.template);
 const ctl=new RemotePlayerAnimationController(model,0,asset.clips,{slideRaise:0});
 const step=(state,speed=0,vy=0,yaw=0,dt=1/60)=>{ctl.update(dt,state,speed,vy,0,yaw);model.updateMatrixWorld(true);};
 ctl.setArmedProfile('brickmaul');
 step(0);
 let equipDone=0;
 assert.ok(ctl.playOverride('equip',{timeScale:BRICKMAUL_TIMING.equipTimeScale,onFinished:()=>equipDone++}));
 let frames=0;while(ctl.overriding&&frames<200){step(0);frames++;}
 const effective=frames/60;
 assert.equal(equipDone,1,'equip onFinished fired once');
 assert.ok(Math.abs(effective-BRICKMAUL_TIMING.equip)<0.05,`equip ended after ~${BRICKMAUL_TIMING.equip.toFixed(2)} s (got ${effective.toFixed(3)} s)`);

 // ---- 2. Layered inspection ----
 const set=asset.clips.profiles.brickmaul;
 assert.ok(set.inspectUpper&&set.lowerBody,'split inspect clips built');
 const upperBones=new Set(set.inspectUpper.tracks.map(t=>bone(t.name)));
 for(const b of ['UpperArm_R','LowerArm_R','Hand_R','Weapon_R','UpperArm_L','LowerArm_L','Head'])assert.ok(upperBones.has(b),`upper layer owns ${b}`);
 for(const b of ['Hips','Spine','Chest','UpperLeg_L','UpperLeg_R','Root','Shoulder_L','Shoulder_R'])assert.ok(!upperBones.has(b),`upper layer never owns ${b}`);
 for(const [k,clip] of Object.entries({hold:set.lowerBody.hold,run:set.lowerBody.run,jump:set.lowerBody.jump,dash:set.lowerBody.dash,slide:set.lowerBody.slide})){
  for(const t of clip.tracks)assert.ok(!upperBones.has(bone(t.name)),`lower ${k}: no overlap with the layer (${t.name})`);
  assert.equal(clip.duration,set[k].duration,`lower ${k} keeps its duration`);
 }
 // Running remote starts an inspection: legs keep the run, arms play the inspect.
 for(let i=0;i<30;i++)step(1,8);
 assert.equal(ctl.currentSlot,'run');
 const legBone=model.getObjectByName('UpperLeg_L');
 const armBone=model.getObjectByName('LowerArm_R');
 assert.ok(ctl.playOverride('inspect',{startAt:0.5}),'inspect starts while running');
 assert.ok(ctl.overriding&&Math.abs(ctl.overrideTime-0.5)<1e-6,'inspection resumes at the elapsed time');
 assert.equal(ctl.currentSlot,'run','the locomotion slot is still RUN (layered, not full-body)');
 const legQ0=legBone.quaternion.clone();const armQ0=armBone.quaternion.clone();
 let legMoved=0,armMoved=0;
 for(let i=0;i<30;i++){step(1,8);legMoved=Math.max(legMoved,legQ0.angleTo(legBone.quaternion));armMoved=Math.max(armMoved,armQ0.angleTo(armBone.quaternion));}
 assert.ok(legMoved>0.1,`legs keep running under the inspection (${legMoved.toFixed(2)} rad)`);
 assert.ok(armMoved>0.05,`arms animate the inspection (${armMoved.toFixed(2)} rad)`);
 // A state change during the inspection keeps the layer alive.
 step(0);assert.equal(ctl.currentSlot,'idle');assert.ok(ctl.overriding,'inspection survives run → idle');
 step(1,8);assert.equal(ctl.currentSlot,'run');assert.ok(ctl.overriding,'inspection survives idle → run');
 // It ends by itself → full locomotion back, callback once.
 ctl.clearOverride(0);assert.ok(!ctl.overriding);
 let insDone=0;ctl.playOverride('inspect',{startAt:BRICKMAUL_TIMING.inspect-0.2,onFinished:()=>insDone++});
 for(let i=0;i<30;i++)step(1,8);
 assert.equal(insDone,1,'inspect onFinished fired once');
 assert.ok(!ctl.overriding,'layer cleared at the end of the clip');
 assert.equal(ctl.currentSlot,'run');
 // An attack replaces the inspection (attack wins).
 ctl.playOverride('inspect',{});
 assert.ok(ctl.playOverride('whirlwind',{}),'whirlwind starts over the inspection');
 assert.ok(Math.abs(ctl.overrideTime)<1e-6,'overrideTime now reports the whirlwind');
 ctl.clearOverride(0);
 // The inspection never interrupts an attack (mirror of the sender).
 ctl.playOverride('slamStart',{});
 assert.equal(ctl.playOverride('inspect',{}),false,'inspect refused during an attack');
 ctl.clearOverride(0);
 ctl.dispose();
 // ---- 3. HexSniper TP grip = Aim (FP parity) ----
 const poses=await read(project+'/src/assets/potato/HexSniper_TP_Poses.glb');
 const aim=poses.animations.find(c=>c.name==='TP_Aim_HexSniper');
 const hold=poses.animations.find(c=>c.name==='TP_Hold_HexSniper');
 assert.equal(asset.clips.armedHold.name,aim.name,'armed idle IS TP_Aim_HexSniper');
 const first=(clip,name)=>{const t=clip.tracks.find(t=>t.name===name);return t?new THREE.Quaternion().fromArray(t.values,0):null;};
 const aimW=first(aim,'UpperArm_R.quaternion'),holdW=first(hold,'UpperArm_R.quaternion');
 assert.ok(aimW.angleTo(holdW)>0.3,'Aim and Hold grips really differ (sanity)');
 // Every armed-layer track of TP_Aim (arm/hand/finger quaternions + the
 // Weapon_R position correction) is frozen at its first sample in each
 // composite — same values as the Aim clip.
 const layerTracks=aim.tracks.filter(t=>['Weapon_R','Hand_R','Hand_L','UpperArm_R','LowerArm_L','Index_R_1'].includes(bone(t.name)));
 assert.ok(layerTracks.length>=6,'sanity: layer tracks found in TP_Aim');
 for(const [k,clip] of Object.entries({run:asset.clips.armedRun,jump:asset.clips.armedJump,dash:asset.clips.armedDash,slide:asset.clips.armedSlide})){
  for(const src of layerTracks){
   const t=clip.tracks.find(t=>t.name===src.name);
   assert.ok(t&&t.times.length===1,`${k}: ${src.name} frozen constant grip`);
   const n=t.getValueSize();
   for(let i=0;i<n;i++)assert.ok(Math.abs(t.values[i]-src.values[i])<1e-6,`${k}: ${src.name}[${i}] equals TP_Aim frame 0`);
  }
 }
 assert.ok(asset.clips.armedRun.tracks.some(t=>bone(t.name)==='UpperLeg_L'),'armed run keeps the TP_Run body');
 console.log('PRESENTATION FIXES TESTS PASSED',JSON.stringify({equipEffective:+effective.toFixed(3)}));
}finally{await server.close();}
