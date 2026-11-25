import { type Bone, Quaternion, Vector3 } from 'three';

import { DEG, simulate } from '../helpers/sim.ts';
import { gapWorld } from './gapLab.ts';

/**
 * Brazos y manos al saltar un hueco: por frame, ángulo del brazo (húmero, ° adelante), codo y muñeca (°) de cada lado,
 * y los mayores saltos de pose (aceleración angular, °/frame²) de antebrazo y mano, con el momento.
 *
 *   node .test-build/tests/tools/leapProbe.js [ancho] [velocidad]     (CONFIG='{"variation":0}' para comparar)
 */
const [width, speed] = [Number(process.argv[2] ?? 0.7), Number(process.argv[3] ?? 1.4)];
const world = gapWorld(width, 10);
const h = world.human;
const rig = h.rig;
const arms = { L: rig.leftArm!, R: rig.rightArm! };
const bones: [string, Bone][] = [
  ['upperArmL', arms.L.upperArm], ['forearmL', arms.L.forearm], ['handL', arms.L.hand],
  ['upperArmR', arms.R.upperArm], ['forearmR', arms.R.forearm], ['handR', arms.R.hand],
];
const prevQ = bones.map(([, b]) => b.getWorldQuaternion(new Quaternion()));
const prevW = bones.map(() => null as Quaternion | null);
const peaks: { a: number; t: number; bone: string; info: string }[] = [];
const q = new Quaternion();
const p = (b: Bone): Vector3 => b.getWorldPosition(new Vector3());
let liftoff = -1;
let land = -1;
let t = 0;
h.on('liftoff', () => { if (liftoff < 0) liftoff = t; });
h.on('land', () => { if (land < 0) land = t; });
const rows: string[] = [];
simulate(world, Math.max(12, 10 / speed + 4), [[0, (x) => { x.targetHeading = 0; x.targetSpeed = speed; }]], {
  dt: 1 / 60,
  onFrame: (time) => {
    t = time;
    const info = `${h.jumpPhase} ${liftoff >= 0 ? `+${(t - liftoff).toFixed(2)}` : ''}`;
    bones.forEach(([name, b], i) => {
      b.getWorldQuaternion(q);
      const w = prevQ[i].clone().invert().premultiply(q);
      if (prevW[i]) peaks.push({ a: w.angleTo(prevW[i]!) / DEG, t, bone: name, info });
      prevW[i] = w;
      prevQ[i].copy(q);
    });
    if (liftoff >= 0 && t < liftoff + Number(process.env.UNTIL ?? 1) && t > liftoff - 0.5) {
      const fwd = new Vector3(0, 0, -1);
      const cols = (['L', 'R'] as const).map((s) => {
        const a = arms[s];
        const sh = p(a.upperArm);
        const el = p(a.forearm);
        const wr = p(a.hand);
        const up = el.clone().sub(sh);
        const arm = Math.atan2(up.dot(fwd), -up.y) / DEG;
        const elbow = up.angleTo(wr.clone().sub(el)) / DEG;
        const tip = a.hand.children[0] ? p(a.hand.children[0] as Bone) : wr;
        const wrist = wr.clone().sub(el).angleTo(tip.clone().sub(wr)) / DEG;
        return `${s} brazo ${arm.toFixed(0).padStart(4)} codo ${elbow.toFixed(0).padStart(4)} muñeca ${wrist.toFixed(0).padStart(4)}`;
      });
      rows.push(`${(t - liftoff).toFixed(3).padStart(7)} ${h.jumpPhase.padEnd(8)} ${cols.join(' | ')}`);
    }
  },
});
for (const r of rows.filter((_, i) => i % (Number(process.env.EVERY ?? 3)) === 0)) console.log(r);
console.log(`\ndespegue ${liftoff.toFixed(2)} s, caída ${land.toFixed(2)} s · mayores picos (°/frame²):`);
for (const k of [...peaks].filter((x) => x.t > liftoff - 1 && x.t < liftoff + 1.5).sort((a, b) => b.a - a.a).slice(0, 12)) {
  console.log(k.a.toFixed(2).padStart(6), (k.t - liftoff).toFixed(3).padStart(7), k.bone.padEnd(10), k.info);
}
