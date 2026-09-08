import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Vector3 } from 'three';
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
for(const id of ['shotgun','revolver','pistol']) {
  test(`${id} export contract rejects corrupt data and missing mechanisms`, async()=>{
    const bytes=readFileSync(new URL(`../../public/assets/${id}.glb`,import.meta.url));
    expect(validateWeaponGlb(bytes,id).vertices).toBeGreaterThan(1000);
    expect(()=>validateWeaponGlb(bytes.subarray(0,-8),id)).toThrow('Truncated');
    const source=await asset(id);
    source.getObjectByName('reload_port').name='missing';
    expect(()=>createAuthoredWeaponRig(id,source)).toThrow('reload_port');
  });
  test(`${id} moving assemblies clone independently`,async()=>{
    const source=await asset(id);
    const a=createAuthoredWeaponRig(id,source), b=createAuthoredWeaponRig(id,source);
    const key=id==='shotgun'?'pump':id==='pistol'?'magazine':'cylinder';
    a.mechanisms[key].rotation.z+=1;
    expect(b.mechanisms[key].rotation.z).toBeCloseTo(0);
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
