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
const server=await createServer({...config,server:{middlewareMode:true},appType:'custom'});
try{
 GLTFLoader.prototype.loadAsync=async function(url){const name=url.split('/').pop().split('?')[0];const dir=/BrickMaul/.test(name)?'src/assets/brickmaul/':'src/assets/potato/';return read(project+'/'+dir+name);};
 const {loadCharacterAsset}=await server.ssrLoadModule('/src/characters/PotatoCharacter.ts');
 const {RemotePlayerAnimationController}=await server.ssrLoadModule('/src/network/remote/RemotePlayerAnimationController.ts');
 const {ViewmodelJumpMotion}=await server.ssrLoadModule('/src/weapons/viewmodel/ViewmodelJumpMotion.ts');
 const asset=await loadCharacterAsset();
 assert.equal(asset.clips.jumpVariants.length,3);
 assert.equal(asset.clips.armedJumpVariants.length,3);
 const usedVariants=new Set();
 let maxGripError=0,landed=0,bounces=0;
 for(const hz of [30,60,144])for(const armed of [false,true]){
  const model=clone(asset.template),ctl=new RemotePlayerAnimationController(model,0,asset.clips,{slideRaise:0});ctl.setArmed(armed);
  const dt=1/hz;let baseline=null;
  function step(state,vy){
   ctl.update(dt,state,0,vy,0,0);model.updateMatrixWorld(true);
   if(ctl.currentSlot==="jump")usedVariants.add(ctl.current.getClip().name);
   model.traverse(o=>{assert.ok(o.matrixWorld.elements.every(Number.isFinite),o.name+' finite');if(o.isBone)assert.ok(o.scale.distanceTo(new THREE.Vector3(1,1,1))<1e-5);});
   if(armed&&ctl.currentSlot==='jump'&&ctl.current.time>0.52){
    const rel=new THREE.Matrix4().copy(model.getObjectByName('Weapon_R').matrixWorld).invert().multiply(model.getObjectByName('Hand_L').matrixWorld);
    if(baseline)maxGripError=Math.max(maxGripError,...rel.elements.map((v,i)=>Math.abs(v-baseline[i])));else baseline=rel.elements.slice();
   }
  }
  for(let i=0;i<hz/3;i++)step(0,0);
  const dur=17.6/26;
  for(let t=0;t<dur;t+=dt){step(2,8.8-26*t);assert.equal(ctl.currentSlot,'jump');assert.ok(ctl.current.time<.9,'never lands by timer');}
  const descendTime=ctl.current.time;assert.ok(descendTime>.8,'distinct descent pose');
  step(0,0);assert.equal(ctl.currentSlot,'land');landed++;
  // Immediate new hop interrupts compression, physics never waits for recovery.
  step(2,8.8);assert.equal(ctl.currentSlot,'jump');assert.ok(ctl.current.time<.4);bounces++;
  for(let t=dt;t<dur;t+=dt)step(2,8.8-26*t);
  // No grounded sample: descending velocity changes to new positive impulse.
  step(2,8.8);assert.ok(ctl.current.time<.4,'network bounce relaunches');
  for(let t=0;t<1;t+=dt)step(0,0);
  assert.equal(ctl.currentSlot,'idle');
  for(let i=0;i<hz;i++)step(2,-20);
  assert.equal(ctl.currentSlot,'jump');assert.ok(ctl.current.time<.9,'long fall never auto lands');
  step(4,3);assert.equal(ctl.currentSlot,'dash');
  step(3,0);assert.equal(ctl.currentSlot,'slide');
  ctl.dispose();
 }
 assert.equal(usedVariants.size,6,'all three variants played with and without weapon');
 assert.ok(maxGripError<1e-4,`two-hand contact transform drift ${maxGripError}`);
 let maxFP=0,maxADS=0;
 for(const hz of [30,60,144]){
  const a=new ViewmodelJumpMotion(),ads=new ViewmodelJumpMotion();let seq=0;
  for(let j=0;j<10;j++){
   for(let t=0;t<.75;t+=1/hz){
    const grounded=t>=17.6/26; if(t===0)seq++;
    const input={grounded,verticalVelocity:grounded?0:8.8-26*t,jumpSequence:seq,straight:false};
    a.update(1/hz,input);ads.update(1/hz,{...input,straight:true});
    maxFP=Math.max(maxFP,Math.abs(a.offsetY));maxADS=Math.max(maxADS,Math.abs(ads.offsetY));
    assert.ok(Math.abs(a.offsetY)<=.02);assert.ok(Math.abs(ads.offsetY)<=.003);
   }
  }
  for(let t=0;t<2;t+=1/hz)a.update(1/hz,{grounded:true,verticalVelocity:0,jumpSequence:seq,straight:false});
  assert.ok(Math.abs(a.offsetY)<1e-7,'spring settles after repeated hops');
 }
 assert.ok(maxFP>.004,'FP movement is present');assert.ok(maxADS<maxFP*.151);
 const result={playedVariants:[...usedVariants],fps:[30,60,144],armedAndUnarmed:true,landingChecks:landed,immediateBounceChecks:bounces,maxGripMatrixError:maxGripError,maxFPTravelMetres:maxFP,maxAimTravelMetres:maxADS};

 console.log('RUNTIME TESTS PASSED',JSON.stringify(result));
}finally{await server.close();}
