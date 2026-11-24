import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import type { Side } from '../../src/index.ts';
import { createWorld, simulate } from '../helpers/sim.ts';

// La pasarela con huecos del Laboratorio (human/lab/terrains.ts, gapWalkway): sube la escalera y va hacia −Z, cruzando
// los huecos de 20, 35 y 50 cm; en el de 65 cm se para. node walkwayLab.js [v | moveTo z]
const RISE = 0.17;
const RUN = 0.28;
const STEPS = 6;
const X = 10;
const WIDTH = 1.6;
const Z0 = 1.7;
const SIZES = [0.2, 0.35, 0.5, 0.65];
const STRETCH = 1.6;
function box(parent: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, z);
  parent.add(mesh);
}
const edges: [number, number][] = [];
const world = createWorld({
  buildTerrain: (g) => {
    for (let k = 1; k < STEPS; k++) box(g, WIDTH, RISE * k, RUN, X, 0, Z0 - RUN * (k - 0.5));
    let z = Z0 - RUN * (STEPS - 1);
    for (const [i, gap] of [...SIZES, 0].entries()) {
      const length = i === 0 ? STRETCH + 0.6 : STRETCH;
      box(g, WIDTH, RISE * STEPS, length, X, 0, z - length / 2);
      z -= length;
      if (gap === 0) break;
      edges.push([z, z - gap]);
      z -= gap;
    }
  },
});
const { human } = world;
world.model.position.set(X, 0, Z0 + 1.5);
world.model.updateMatrixWorld(true);
world.human.reset();
const mode = process.argv[2] ?? '1.4';
const order = mode === 'moveTo' ? (h: typeof human): void => { h.moveTo(new Vector3(X, RISE * STEPS, Number(process.argv[3] ?? -6))); } : (h: typeof human): void => { h.targetHeading = 0; h.targetSpeed = Number(mode); };
const was: Record<Side, boolean> = { left: false, right: false };
let longest = 0;
let lowest = Infinity;
let inGap = 0;
const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
simulate(world, 20, [[0, order]], {
  onFrame: () => {
    const s = human.locomotion.body.state;
    if (process.env.TRACE && Math.round(s.position.z * 20) % 5 === 0) console.log(`  z ${s.position.z.toFixed(2)} y ${s.position.y.toFixed(2)} x ${s.position.x.toFixed(2)} ruta ${human.movePath?.map((q) => `(${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)})`).join(" ") ?? "-"}`);
    if (s.position.z < Z0 - RUN * STEPS) lowest = Math.min(lowest, s.position.y);
    for (const side of ['left', 'right'] as const) {
      const air = human.footPhase(side) === 'SWING';
      if (was[side] && !air) {
        const a = p(human.rig[side].foot);
        longest = Math.max(longest, a.distanceTo(p(human.rig[side === 'left' ? 'right' : 'left'].foot)));
        if (edges.some(([near, far]) => a.z < near && a.z > far)) inGap++;
      }
      was[side] = air;
    }
  },
});
console.log(`pasarela (${mode}${mode === 'moveTo' ? ' ' + (process.argv[3] ?? -6) : ' m/s'}): final z ${human.position.z.toFixed(2)} y ${human.position.y.toFixed(2)}; huecos en z ${edges.map(([a, b]) => `${a.toFixed(2)}…${b.toFixed(2)}`).join(', ')}; raíz mín ${lowest.toFixed(2)}; tobillos en un hueco ${inGap}; paso más largo ${longest.toFixed(2)} m`);
