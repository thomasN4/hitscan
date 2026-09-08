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
for(const id of ['shotgun','revolver']) {
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
    const key=id==='shotgun'?'pump':'cylinder';
    a.mechanisms[key].rotation.z+=1;
    expect(b.mechanisms[key].rotation.z).toBeCloseTo(0);
  });
}
test('revolver cartridge follows the exposed chamber and closes without pose residue',async()=>{
  const vm=createWeaponViewModel('revolver',{shotgun:await asset('shotgun'),revolver:await asset('revolver')});
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
