import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {clone} from 'three/examples/jsm/utils/SkeletonUtils.js';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/').replace(/\/$/,'');
const config={root:project,configFile:false};
globalThis.self=globalThis;
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
THREE.TextureLoader.prototype.load=function(u,done){const tex=new THREE.Texture();queueMicrotask(()=>done?.(tex));return tex;};
THREE.ImageBitmapLoader.prototype.load=function(u,done){queueMicrotask(()=>done?.({width:1,height:1,close(){}}));};
const read=async file=>{const b=fs.readFileSync(file);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
const server=await createServer({...config,server:{...config.server,middlewareMode:true},appType:'custom'});
try{
 GLTFLoader.prototype.loadAsync=async function(url){const rel='src/assets/potato/'+url.split('/').pop().split('?')[0];return read(project+'/'+rel);};
 const {loadCharacterAsset}=await server.ssrLoadModule('/src/characters/PotatoCharacter.ts');
 const {RemotePlayerAnimationController}=await server.ssrLoadModule('/src/network/remote/RemotePlayerAnimationController.ts');
 const {ViewmodelSlideMotion}=await server.ssrLoadModule('/src/weapons/viewmodel/ViewmodelSlideMotion.ts');
 const asset=await loadCharacterAsset();
 let maxGripError=0,maxWeaponAngle=0,maxHipsRange=0,maxLeafAngle=0,maxFP=0,maxADS=0;
 for(const hz of [30,60,144])for(const armed of [false,true]){
  const model=clone(asset.template),ctl=new RemotePlayerAnimationController(model,0,asset.clips,{slideRaise:0});ctl.setArmed(armed);
  const dt=1/hz,pos=new THREE.Vector3(),q=new THREE.Quaternion(),hips=model.getObjectByName('Hips'),leaf=model.getObjectByName('Plant_Root'),weapon=model.getObjectByName('Weapon_R'),left=model.getObjectByName('Hand_L');
  const step=(state,speed=12,vy=0)=>{ctl.update(dt,state,speed,vy,0,0);model.updateMatrixWorld(true);};
  for(let i=0;i<hz;i++)step(0);
  const grip=new THREE.Matrix4().copy(weapon.matrixWorld).invert().multiply(left.matrixWorld);
  const held=weapon.getWorldQuaternion(new THREE.Quaternion());
  const box=new THREE.Box3();let firstLeaf=null,firstWeapon=null,times=new Set();
  for(let i=0;i<hz*4;i++){
   step(3);
   if(i>hz/2){
    assert.ok(ctl.current.time>=10/30-1e-7&&ctl.current.time<1.1,'repeat only central segment');
    times.add(ctl.current.time.toFixed(4));box.expandByPoint(hips.getWorldPosition(pos));
    leaf.getWorldQuaternion(q);if(!firstLeaf)firstLeaf=q.clone();maxLeafAngle=Math.max(maxLeafAngle,firstLeaf.angleTo(q));
    if(armed){
     const rel=new THREE.Matrix4().copy(weapon.matrixWorld).invert().multiply(left.matrixWorld);
     maxGripError=Math.max(maxGripError,...rel.elements.map((v,j)=>Math.abs(v-grip.elements[j])));
     weapon.getWorldQuaternion(q);if(!firstWeapon)firstWeapon=q.clone();
     maxWeaponAngle=Math.max(maxWeaponAngle,firstWeapon.angleTo(q));
    }
   }
  }
  assert.ok(times.size>15,'slide is not a frozen pose');maxHipsRange=Math.max(maxHipsRange,box.getSize(pos).length());
  const before=ctl.current.time;ctl.setArmed(!armed);step(3);assert.ok(Math.abs(ctl.current.time-before)<.05||before>1.06,'equip preserves loop phase');ctl.setArmed(armed);
  step(0);assert.equal(ctl.currentSlot,'slideExit','actual grounded exit plays recovery');
  for(let i=0;i<hz/2;i++)step(0);assert.equal(ctl.currentSlot,'idle');
  step(3);step(2,12,8.8);assert.equal(ctl.currentSlot,'jump','short slide interrupts immediately');
  step(3);step(4);assert.equal(ctl.currentSlot,'dash');
  step(3);step(1);assert.equal(ctl.currentSlot,'run','cancelled entry must not dive into a full low recovery pose');
  for(let i=0;i<hz/2;i++)step(3);
  step(1);assert.equal(ctl.currentSlot,'slideExit');step(2,12,8.8);assert.equal(ctl.currentSlot,'jump','recovery interruptible');
  step(3);step(1);step(3);assert.equal(ctl.currentSlot,'slide');assert.ok(ctl.current.time<.1,'new slide replays entry');
  model.traverse(o=>{assert.ok(o.matrixWorld.elements.every(Number.isFinite));if(o.isBone)assert.ok(o.scale.distanceTo(new THREE.Vector3(1,1,1))<1e-5);});
  ctl.dispose();
  const fp=new ViewmodelSlideMotion(),ads=new ViewmodelSlideMotion();
  for(let i=0;i<hz*5;i++){
   const sliding=i%(hz*1.0)<hz*.65;fp.update(dt,sliding,12,false);ads.update(dt,sliding,12,true);
   maxFP=Math.max(maxFP,Math.abs(fp.offsetY));maxADS=Math.max(maxADS,Math.abs(ads.offsetY));
   assert.ok(Math.abs(fp.offsetY)<.018);assert.ok(Math.abs(ads.offsetY)<.0027);
  }
  for(let i=0;i<hz*2;i++)fp.update(dt,false,0,false);
  assert.ok(Math.abs(fp.offsetY)<1e-8,'FP settles after slide chains');
 }
 assert.ok(maxHipsRange>.02);assert.ok(maxLeafAngle>THREE.MathUtils.degToRad(15));
 assert.ok(maxGripError<1e-4,`grip drift ${maxGripError}`);
 // The 1.2-degree chest follow-through is intentional; the 35-degree hip lean
 // must not rotate the weapon with it.
 assert.ok(maxWeaponAngle<THREE.MathUtils.degToRad(1.5),`weapon pitch ${maxWeaponAngle}`);
 const report={fps:[30,60,144],armedAndUnarmed:true,loopIsLive:true,exitsAndInterruptions:true,maxHipsRangeMetres:maxHipsRange,maxLeafAngleDegrees:THREE.MathUtils.radToDeg(maxLeafAngle),maxGripMatrixError:maxGripError,maxWeaponAngleDegrees:THREE.MathUtils.radToDeg(maxWeaponAngle),maxFPTravelMetres:maxFP,maxADSTravelMetres:maxADS};
 console.log('SLIDE TESTS PASSED',JSON.stringify(report));
}finally{await server.close();}
