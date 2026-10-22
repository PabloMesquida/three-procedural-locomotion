import { type Bone, Quaternion } from 'three';

import { createWorld, DEG, simulate, type Step } from '../helpers/sim.ts';

/**
 * Saltos de pose: aceleración angular de cada hueso (cambio de su velocidad angular world entre
 * frames, °/frame²) en un recorrido con todas las transiciones. Lista los mayores picos con el
 * momento y el estado de la marcha, para saber dónde hay "pops".
 *
 *   node .test-build/tests/tools/popProbe.js
 */
const world = createWorld();
const h = world.human;
const rig = h.rig;
const bones: [string, Bone][] = [
  ['hips', rig.hips], ['spine', rig.spine!], ['chest', rig.chest!], ['neck', rig.neck!], ['head', rig.head!],
  ['thighL', rig.left.thigh], ['shinL', rig.left.shin], ['footL', rig.left.foot],
  ['upperArmL', rig.leftArm!.upperArm], ['forearmL', rig.leftArm!.forearm], ['handL', rig.leftArm!.hand],
  ['upperArmR', rig.rightArm!.upperArm], ['forearmR', rig.rightArm!.forearm], ['handR', rig.rightArm!.hand],
];
const script: Step[] = [
  [0.5, (x) => { x.targetSpeed = 1.4; }],
  [4, (x) => { x.targetSpeed = 0; }],
  [6, (x) => { x.targetSpeed = 1.4; x.targetHeading = 90 * DEG; }],
  [9, (x) => { x.targetSpeed = 3; }],
  [12, (x) => { x.targetHeading = 0; }],
  [14, (x) => { x.targetSpeed = 1.4; }],
  [16, (x) => x.jump()],
  [18, (x) => { x.targetCrouch = 1; x.targetSpeed = 0.6; }],
  [20, (x) => { x.targetCrouch = 0; x.targetSpeed = 0; }],
];
const prevQ = bones.map(([, b]) => b.getWorldQuaternion(new Quaternion()));
const prevW = bones.map(() => null as Quaternion | null);
const peaks: { a: number; t: number; bone: string; info: string }[] = [];
const q = new Quaternion();
simulate(world, 23, script, {
  onFrame: (t) => {
    const g = h.locomotion.gait;
    const info = `${h.gaitMode} ${h.jumpPhase} v ${h.speed.toFixed(2)} blend ${g.blend.toFixed(2)} L ${h.locomotion.feet.left.phase} R ${h.locomotion.feet.right.phase}`;
    bones.forEach(([name, b], i) => {
      b.getWorldQuaternion(q);
      const w = prevQ[i].clone().invert().premultiply(q); // giro de este frame (world)
      if (prevW[i]) {
        const a = w.angleTo(prevW[i]!) / DEG; // cambio de la velocidad angular, °/frame²
        peaks.push({ a, t, bone: name, info });
      }
      prevW[i] = w;
      prevQ[i].copy(q);
    });
  },
});
const byBone = new Map<string, number[]>();
for (const p of peaks) byBone.set(p.bone, [...(byBone.get(p.bone) ?? []), p.a]);
console.log('hueso        mediana   p99    máx  (°/frame²)');
for (const [name, list] of byBone) {
  const s = [...list].sort((a, b) => a - b);
  console.log(name.padEnd(12), s[Math.floor(s.length / 2)].toFixed(2).padStart(6), s[Math.floor(s.length * 0.99)].toFixed(2).padStart(6), s[s.length - 1].toFixed(2).padStart(6));
}
console.log('\nmayores picos:');
for (const p of [...peaks].sort((a, b) => b.a - a.a).slice(0, 15)) console.log(p.a.toFixed(2).padStart(6), p.t.toFixed(2).padStart(6), p.bone.padEnd(10), p.info);
