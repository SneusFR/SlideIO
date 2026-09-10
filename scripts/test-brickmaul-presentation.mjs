/**
 * BRICK MAUL r5 — TP presentation regression (no WebGL):
 *   - the profile TP pose set is built from the real GLBs;
 *   - locomotion composites respect EXACTLY the authored upperBodyMask
 *     (right arm / right fingers / Weapon_R from the maul, everything else
 *     — including the LEFT arm and the shoulders — from the locomotion);
 *   - every action clip (Whirlwind / Slam_* / Inspect / Equip / Unequip)
 *     resolves and the full-body override plays with priority, resumes at
 *     an elapsed time and hands back to the real locomotion when it ends;
 *   - the Whirlwind Root yaw is NOT doubled by the controller (the model's
 *     leg-yaw eases to 0 while the override runs).
 * Run: node scripts/test-brickmaul-presentation.mjs
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
 const {BrickMaulProfile,BRICKMAUL_TIMING}=await server.ssrLoadModule('/src/weapons/brickmaul/BrickMaulProfile.ts');
 const profileJson=JSON.parse(fs.readFileSync(project+'/src/assets/brickmaul/WeaponProfile_BrickMaul.json','utf8'));
 const asset=await loadCharacterAsset();
 const set=asset.clips.profiles?.brickmaul;
 assert.ok(set,'brickmaul TP profile set built');
 const bone=n=>n.slice(0,n.lastIndexOf('.'));
 const mask=new Set(profileJson.upperBodyMask);
 assert.deepEqual([...mask].sort(),['Hand_R','Index_R_1','LowerArm_R','Middle_R_1','Ring_R_1','Thumb_R_1','UpperArm_R','Weapon_R'].sort(),'mask is exactly the authored list');
 // Composites: masked bones come from the maul layer, others from locomotion.
 for(const [name,clip,base] of [['run',set.run,asset.clips.run],['jump',set.jump,asset.clips.jump],['dash',set.dash,asset.clips.dash],['slide',set.slide,asset.clips.slide]]){
  const baseNames=new Set(base.tracks.map(t=>t.name));
  for(const t of clip.tracks){
   const b=bone(t.name);
   if(mask.has(b)){
    if(name!=='run')assert.equal(t.times.length,1,`${name}: ${t.name} frozen at its first sample`);
   }else{
    assert.ok(baseNames.has(t.name),`${name}: ${t.name} must come from the locomotion clip`);
   }
  }
  assert.equal(clip.duration,base.duration,`${name}: composite keeps the locomotion duration`);
 }
 for(const b of ['Shoulder_L','Shoulder_R','UpperArm_L','LowerArm_L','Hand_L','Spine_1','Head'])assert.ok(!mask.has(b),`${b} outside the mask`);
 // Every action clip resolves with the authored duration.
 const dur={whirlwind:1.35,slamStart:0.2,slamDive:0.4,slamLand:0.82};
 for(const [k,d] of Object.entries(dur)){assert.ok(set.actions[k],`action ${k}`);assert.ok(Math.abs(set.actions[k].duration-d)<0.02,`${k} duration ${set.actions[k].duration}`);}
 assert.ok(Math.abs(set.inspect.duration-3.6)<0.02&&Math.abs(set.equip.duration-0.65)<0.02&&Math.abs(set.unequip.duration-0.3)<0.02,'inspect/equip/unequip durations');
 assert.equal(BRICKMAUL_TIMING.slam.recoveryAfterGroundContact,0.72);
 assert.equal(BrickMaulProfile.id,'brickmaul');
 // FP library keeps EVERY track (Shoulder_R / UpperArm_R translations included).
 const fp=await read(project+'/src/assets/brickmaul/Potato_FP_BrickMaul.glb');
 const fpLand=fp.animations.find(c=>c.name==='FP_BrickMaul_Slam_Land');
 assert.ok(fpLand.tracks.some(t=>t.name==='Shoulder_R.position')&&fpLand.tracks.some(t=>t.name==='UpperArm_R.position'),'FP Shoulder_R/UpperArm_R translations present');
 assert.equal(fp.animations.length,9);

 // ---- r6: FP whirlwind camera spin curve (pure function of the attack clock) ----
 const {sampleBrickMaulWhirlwindYaw}=await server.ssrLoadModule('/src/weapons/brickmaul/BrickMaulWhirlwindCamera.ts');
 const turns=t=>sampleBrickMaulWhirlwindYaw(t)/(2*Math.PI);
 for(const [t,expected] of [[0,0],[0.2,0],[0.4912,1],[0.62,1.5],[0.7488,2],[1.04,3],[1.35,3],[5,3],[-1,0]]){
  assert.ok(Math.abs(turns(t)-expected)<1e-6,`spin at ${t}s = ${turns(t).toFixed(4)} turns (expected ${expected})`);
 }
 // Monotonic, unwrapped, same phase whatever the frame rate / a long frame.
 let prev=-1;for(let t=0;t<=1.4;t+=1/144){const v=turns(t);assert.ok(v>=prev-1e-9);prev=v;}
 for(const hz of [30,60,144]){let t=0,last=0;while(t<1.35){t+=1/hz;last=turns(Math.min(t,1.35));}assert.ok(Math.abs(last-3)<1e-6,`3 turns at ${hz} Hz`);}
 assert.ok(Math.abs(turns(0.05+1.2)-3)<1e-6,'long frame lands on the held full angle');
 // The FP Whirlwind clip no longer turns its Root (the camera does).
 const fpWhirl=fp.animations.find(c=>c.name==='FP_BrickMaul_Whirlwind');
 const fpRootRot=fpWhirl.tracks.find(t=>t.name==='Root.quaternion');
 if(fpRootRot){const q0=new THREE.Quaternion().fromArray(fpRootRot.values,0);let maxAng=0;for(let i=0;i<fpRootRot.values.length;i+=4){const q=new THREE.Quaternion().fromArray(fpRootRot.values,i);maxAng=Math.max(maxAng,q0.angleTo(q));}assert.ok(maxAng<0.05,'FP Root performs no turn ('+maxAng.toFixed(3)+' rad)');}
 assert.equal(profileJson.actions.whirlwind.cameraSpin.turns,3);

 // ---- Controller: override lifecycle + no doubled root yaw ----
 const model=clone(asset.template);
 const ctl=new RemotePlayerAnimationController(model,0,asset.clips,{slideRaise:0});
 const step=(state,speed=0,vy=0,yaw=0.6,dt=1/60)=>{ctl.update(dt,state,speed,vy,0,yaw);model.updateMatrixWorld(true);};
 ctl.setArmedProfile('brickmaul');
 assert.equal(ctl.armedProfileId,'brickmaul');
 for(let i=0;i<30;i++)step(1,8);// RUNNING with strafe yaw → legs turned
 assert.ok(Math.abs(model.rotation.y)>0.2,'strafe leg yaw active before the attack');
 assert.ok(ctl.playOverride('whirlwind',{startAt:0.5}),'whirlwind override starts');
 assert.ok(ctl.overriding&&Math.abs(ctl.overrideTime-0.5)<1e-6,'resumes at the elapsed time');
 const root=model.getObjectByName('Root');
 let maxRootYawRate=0,prevYaw=null;
 for(let i=0;i<40;i++){step(1,8);const e=new THREE.Euler().setFromQuaternion(root.quaternion,'YXZ');if(prevYaw!==null){let d=e.y-prevYaw;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;maxRootYawRate=Math.max(maxRootYawRate,Math.abs(d)*60);}prevYaw=e.y;}
 assert.ok(ctl.overriding,'still inside the 1.35 s whirlwind (0.5 + 0.67 s)');
 assert.ok(maxRootYawRate>3,'the Whirlwind clip really turns the Root ('+maxRootYawRate.toFixed(1)+' rad/s)');
 assert.ok(Math.abs(model.rotation.y)<0.05,'controller leg-yaw eased to 0 during the override (no second rotation)');
 // The one-shot ends → back to the REAL locomotion (run), callback once.
 let finished=0;ctl.clearOverride(0);ctl.playOverride('whirlwind',{startAt:1.2,onFinished:()=>finished++});
 for(let i=0;i<30;i++)step(1,8);
 assert.equal(finished,1,'onFinished fired exactly once');
 assert.ok(!ctl.overriding,'override cleared at the end of the clip');
 assert.equal(ctl.currentSlot,'run');
 // Slam: start → impact interrupts → land; a stale start callback never fires.
 let stale=0;ctl.playOverride('slamStart',{onFinished:()=>stale++});
 step(0);ctl.playOverride('slamLand',{startAt:0.1,fadeIn:0.02});
 for(let i=0;i<70;i++)step(0);
 assert.equal(stale,0,'replaced Slam_Start callback invalidated');
 assert.ok(!ctl.overriding,'Slam_Land (0.72 s left) ended → locomotion back');
 assert.equal(ctl.currentSlot,'idle');
 // Inspect resumes late + is cancelled by a weapon change.
 ctl.playOverride('inspect',{startAt:2});
 assert.ok(Math.abs(ctl.overrideTime-2)<1e-6);
 ctl.setArmedProfile(null);
 assert.ok(!ctl.overriding&&ctl.armedProfileId===null,'weapon change clears the inspection');
 // HexSniper path untouched.
 ctl.setArmed(true);assert.equal(ctl.armedProfileId,'hexsniper');
 assert.equal(ctl.playOverride('whirlwind',{}),false,'no maul action on the sniper set');
 console.log('BRICKMAUL TP TESTS PASSED',JSON.stringify({maskBones:mask.size,actions:Object.keys(set.actions),maxRootYawRate:+maxRootYawRate.toFixed(2)}));
}finally{await server.close();}
