import { Vector3 } from 'three';

import { simulate } from '../helpers/sim.ts';
import { cliffWorld } from './ledgeLab.ts';

// Traza la entrada a la cornisa del acantilado: cuerpo, mezcla de cornisa, giro y cada pie (respecto a la cara y al cuerpo).
const FACE = -11;
const [sx, sz, tx, from, to] = process.argv.slice(2).map(Number);
const world = cliffWorld(sx, FACE + sz);
const { human } = world;
let t = 0;
simulate(world, to + 0.1, [[0, (h) => h.moveTo(new Vector3(tx, 0.17 * 8, FACE + 0.17))]], {
  onFrame: () => {
    t += 1 / 60;
    if (t < from || t > to || Math.round(t * 60) % 3 !== 0) return;
    const s = human.locomotion.body.state;
    const right = new Vector3().crossVectors(s.forward, new Vector3(0, 1, 0));
    const foot = (side: 'left' | 'right'): string => {
      const p = human.rig[side].foot.getWorldPosition(new Vector3());
      const rel = p.clone().sub(s.position);
      return `${side[0]} ${human.footPhase(side).padEnd(7)} pared ${((p.z - FACE) * 100).toFixed(0).padStart(4)} lado ${(rel.dot(right) * 100).toFixed(0).padStart(4)}`;
    };
    console.log(`t ${t.toFixed(2)} x ${s.position.x.toFixed(2)} pared ${((s.position.z - FACE) * 100).toFixed(0)} v ${s.speed.toFixed(2)} cornisa ${human.ledge.toFixed(2)} giro ${((s.facingOffset * 180) / Math.PI).toFixed(0).padStart(4)}° | ${foot('left')} | ${foot('right')}`);
  },
});
