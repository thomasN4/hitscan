import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PerspectiveCamera, Vector3 } from 'three';
import { BASE_FOV } from '../../src/core/state.ts';
import { createAuthoredWeaponRig, attachmentPoint } from '../../src/core/weaponAssets.ts';
import { validateWeaponGlb } from './weapon-pipeline.mjs';
import { createWeaponViewModel } from '../../src/core/weaponModels.ts';
import { poseWeapon } from '../../src/core/weaponPresentation.ts';
import { weaponPose } from '../../src/sim/weaponAnimation.ts';
async function asset(id) {
  const bytes=readFileSync(new URL(`../../public/assets/${id}.glb`,import.meta.url));
  const buffer=new ArrayBuffer(bytes.length); new Uint8Array(buffer).set(bytes);
  return (await new GLTFLoader().parseAsync(buffer,'')).scene;
}
for(const id of ['shotgun','revolver','pistol','smg','sniper','knife']) {
  test(`${id} export contract rejects corrupt data and missing mechanisms`, async()=>{
    const bytes=readFileSync(new URL(`../../public/assets/${id}.glb`,import.meta.url));
    expect(validateWeaponGlb(bytes,id).vertices).toBeGreaterThan(1000);
    expect(()=>validateWeaponGlb(bytes.subarray(0,-8),id)).toThrow('Truncated');
    const source=await asset(id);
    const marker=id==='knife'?'blade_tip':'reload_port';
    source.getObjectByName(marker).name='missing';
    expect(()=>createAuthoredWeaponRig(id,source)).toThrow(marker);
  });
  test(`${id} moving assemblies clone independently`,async()=>{
    const source=await asset(id);
    const a=createAuthoredWeaponRig(id,source), b=createAuthoredWeaponRig(id,source);
    const key=id==='shotgun'?'pump':id==='revolver'?'cylinder':'magazine';
    const movingA=id==='knife'?a.grip:a.mechanisms[key];
    const movingB=id==='knife'?b.grip:b.mechanisms[key];
    movingA.rotation.z+=1;
    expect(movingB.rotation.z).toBeCloseTo(0);
  });
}
test('revolver cartridge follows the exposed chamber and closes without pose residue',async()=>{
  const vm=createWeaponViewModel('revolver',{shotgun:await asset('shotgun'),revolver:await asset('revolver'),pistol:await asset('pistol')});
  const input={id:'revolver',now:10,shotAt:-10,fireInterval:.6,switchedAt:0,hasOutgoing:false,aiming:false,reloading:true,reloadStartedAt:9,reloadT:.5,roundInterval:.6,lastRound:false,emptyReload:false,closeAt:0,closeBlend:0};
  const closed=attachmentPoint(vm.authored.port,vm.body);
  for(const t of [.25,.5,.8]) {
    poseWeapon(vm,'revolver',weaponPose({...input,reloadT:t}),10,0,0);
    vm.group.updateMatrixWorld(true);
    const opened=attachmentPoint(vm.authored.port,vm.body);
    expect(opened.x).toBeLessThan(closed.x-.04);
    // The cartridge tracks the swung-out chamber, not the rest-pose port.
    expect(vm.mechanisms.shell.position.distanceTo(opened.clone().add(new Vector3(0,0,.070-.066*weaponPose({...input,reloadT:t}).insert)))).toBeLessThan(1e-6);
  }
  poseWeapon(vm,'revolver',weaponPose({...input,reloading:false}),10,0,0);
  expect(attachmentPoint(vm.authored.port,vm.body).distanceTo(closed)).toBeLessThan(1e-6);
  expect(vm.mechanisms.shell.visible).toBe(false);
});

test('pistol rejects a moving magwell marker and a backward insertion path', async()=>{
  const source=await asset('pistol');
  const out=source.getObjectByName('magazine_out');
  source.getObjectByName('mechanism_magazine').attach(out);
  expect(()=>createAuthoredWeaponRig('pistol',source)).toThrow('hierarchy');
  source.attach(out);
  out.position.copy(source.getObjectByName('reload_port').position);
  expect(()=>createAuthoredWeaponRig('pistol',source)).toThrow('magazine path');
});

test('pistol magazine follows the authored well and restores after every reload milestone', async()=>{
  const vm=createWeaponViewModel('pistol',{pistol:await asset('pistol')});
  const magazine=vm.mechanisms.magazine, slide=vm.mechanisms.slide;
  const rest=magazine.position.clone(), slideRest=slide.position.clone();
  const input={id:'pistol',now:10,shotAt:-10,fireInterval:.25,switchedAt:0,hasOutgoing:false,aiming:false,reloading:true,reloadStartedAt:9,reloadT:0,roundInterval:2,lastRound:false,emptyReload:false,closeAt:0,closeBlend:0};
  const travel=attachmentPoint(vm.authored.magazineOut,vm.body).sub(attachmentPoint(vm.authored.port,vm.body));
  expect(travel.y).toBeLessThan(-.13);
  expect(travel.z).toBeGreaterThan(.04);
  for (const emptyReload of [false,true]) for(let i=0;i<=100;i++) {
    const pose=weaponPose({...input,reloadT:i/100,emptyReload});
    poseWeapon(vm,'pistol',pose,10,0,0);
    const expected=rest.clone().addScaledVector(travel,pose.magazine);
    expect(magazine.position.distanceTo(expected)).toBeLessThan(1e-6);
    if (pose.charge>0) expect(magazine.position.distanceTo(rest)).toBeLessThan(1e-6);
    if (!emptyReload) expect(slide.position.distanceTo(slideRest)).toBeLessThan(1e-6);
    // Repeating a frozen game time never accumulates offsets.
    const frozen=magazine.position.clone();
    poseWeapon(vm,'pistol',pose,10,0,0);
    expect(magazine.position.distanceTo(frozen)).toBeLessThan(1e-6);
    poseWeapon(vm,'pistol',weaponPose({...input,reloading:false}),10,0,0);
    expect(magazine.position.distanceTo(rest)).toBeLessThan(1e-6);
    expect(slide.position.distanceTo(slideRest)).toBeLessThan(1e-6);
  }
  poseWeapon(vm,'pistol',weaponPose({...input,reloading:false,shotAt:9.97}),10,0,0);
  expect(slide.position.z-slideRest.z).toBeCloseTo(.045);
  expect(magazine.position.distanceTo(rest)).toBeLessThan(1e-6);
});

for (const id of ['smg','sniper']) {
  test(`${id} rejects detached actions and sideways magazine extraction`, async()=>{
    const source=await asset(id);
    const mechanism=source.getObjectByName(id==='smg'?'mechanism_slide':'mechanism_bolt');
    const magazine=source.getObjectByName('mechanism_magazine');
    magazine.attach(mechanism);
    expect(()=>createAuthoredWeaponRig(id,source)).toThrow('hierarchy');
    source.attach(mechanism);
    source.getObjectByName('magazine_out').position.x=.1;
    expect(()=>createAuthoredWeaponRig(id,source)).toThrow('magazine path');
  });
  test(`${id} magazines clear the well and actions restore after partial/empty reloads`, async()=>{
    const vm=createWeaponViewModel(id,{[id]:await asset(id)});
    const input={id,now:10,shotAt:-10,fireInterval:1,switchedAt:0,hasOutgoing:false,aiming:false,
      reloading:true,reloadStartedAt:9,reloadT:0,roundInterval:2,lastRound:false,
      emptyReload:false,closeAt:0,closeBlend:0};
    const magazine=vm.mechanisms.magazine;
    const rest=vm.rest.get(magazine).position;
    const travel=attachmentPoint(vm.authored.magazineOut,vm.body).sub(attachmentPoint(vm.authored.port,vm.body));
    expect(travel.y).toBeLessThan(-.15);
    let fullyExtracted=false, charged=false;
    for (const emptyReload of [false,true]) for(let i=0;i<=100;i++) {
      const pose=weaponPose({...input,reloadT:i/100,emptyReload});
      poseWeapon(vm,id,pose,10,0,0);
      expect(magazine.position.distanceTo(rest.clone().addScaledVector(travel,pose.magazine))).toBeLessThan(1e-6);
      if (pose.magazine>.99) fullyExtracted=true;
      if (pose.charge>.9) {
        charged=true;
        expect(magazine.position.distanceTo(rest)).toBeLessThan(1e-6);
        const action=vm.mechanisms[id==='smg'?'slide':'bolt'];
        expect(action.position.z-vm.rest.get(action).position.z).toBeGreaterThan(.04);
      }
      const frozen=magazine.position.clone();
      poseWeapon(vm,id,pose,10,0,0);
      expect(magazine.position.distanceTo(frozen)).toBeLessThan(1e-6);
      poseWeapon(vm,id,weaponPose({...input,reloading:false}),10,0,0);
      for(const [node,initial] of vm.rest) {
        expect(node.position.distanceTo(initial.position)).toBeLessThan(1e-6);
        for (const axis of ['x','y','z']) expect(node.rotation[axis]).toBeCloseTo(initial.rotation[axis],8);
      }
    }
    expect(fullyExtracted).toBe(true);
    expect(charged).toBe(true);
  });
}
test('knife has a blade tip and no firearm mechanisms or loading markers',async()=>{
  const vm=createWeaponViewModel('knife',{knife:await asset('knife')});
  expect(vm.authored.bladeTip.position.z).toBeLessThan(-.4);
  expect(vm.authored.port).toBeUndefined();
  expect(vm.authored.muzzle).toBeUndefined();
  expect(vm.authored.magazineOut).toBeUndefined();
  expect(Object.keys(vm.mechanisms)).toEqual([]);
});

for (const id of ['smg','sniper']) test(`${id} extracted magazine stays visible during reload`,async()=>{
  const vm=createWeaponViewModel(id,{[id]:await asset(id)});
  for (const aspect of [4/3,16/9,21/9]) {
    const camera=new PerspectiveCamera(BASE_FOV,aspect,.1,300);
    camera.updateMatrixWorld(true);
    const pose=weaponPose({id,now:10,shotAt:-10,fireInterval:1,switchedAt:0,hasOutgoing:false,
      aiming:false,reloading:true,reloadStartedAt:9,reloadT:.5,roundInterval:2,lastRound:false,
      emptyReload:false,closeAt:0,closeBlend:0});
    poseWeapon(vm,id,pose,10,0,0);
    vm.group.updateMatrixWorld(true);
    let vertices=0, maxX=0, maxY=0, minZ=Infinity, maxZ=-Infinity;
    vm.mechanisms.magazine.traverse(node=>{
      if (!node.isMesh) return;
      const positions=node.geometry.getAttribute('position');
      for(let i=0;i<positions.count;i++) {
        const point=new Vector3().fromBufferAttribute(positions,i).applyMatrix4(node.matrixWorld).project(camera);
        maxX=Math.max(maxX,Math.abs(point.x));
        maxY=Math.max(maxY,Math.abs(point.y));
        minZ=Math.min(minZ,point.z);
        maxZ=Math.max(maxZ,point.z);
        vertices++;
      }
    });
    expect(vertices).toBeGreaterThan(100);
    expect(maxX,`${id} magazine horizontal framing at ${aspect}`).toBeLessThan(.95);
    expect(maxY,`${id} magazine vertical framing at ${aspect}`).toBeLessThan(.95);
    expect(minZ).toBeGreaterThan(-1);
    expect(maxZ).toBeLessThan(1);
  }
});
