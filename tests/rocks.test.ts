import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IcosahedronGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import { createGroundHit, RaycastGroundDetector } from '../src/index.ts';
import { createWorld, SIDES, simulate } from './helpers/sim.ts';

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Montículo de rocas a lo largo de −Z (de z = −1 a −6), de ~0,6 m en el medio. */
function rocks(t: Object3D, top: number): void {
  const r = random(5);
  const geometry = new IcosahedronGeometry(1, 1);
  for (let z = -1; z >= -6; z -= 0.45) {
    for (let x = -1.2; x <= 1.2; x += 0.45) {
      const size = 0.3 + r() * 0.15;
      const height = top * Math.sin((Math.PI * (-1 - z)) / 5) + (r() - 0.5) * 0.12;
      const rock = new Mesh(geometry, new MeshBasicMaterial());
      rock.scale.set(size, size * 0.6, size * (0.8 + r() * 0.4));
      rock.rotation.set((r() - 0.5) * 0.4, r() * Math.PI, (r() - 0.5) * 0.4);
      rock.position.set(x + (r() - 0.5) * 0.15, height - size * 0.6 * 0.55, z + (r() - 0.5) * 0.15);
      t.add(rock);
    }
  }
}
// Terreno irregular sin escalones, como las rocas del diorama: un montículo de rocas (icosaedros achatados y algo
// girados, repetibles con una semilla) de 2,4 m de ancho que sube hasta `top` en el medio y vuelve a bajar, cruzado
// con moveTo. Los pies apoyan en lo más alto bajo ellos (sobre un hueco entre rocas la planta puede quedar unos
// centímetros por encima del suelo bajo el tobillo), sin hundirse.
describe('rocas (terreno irregular sin escalones)', () => {
for (const top of [0.4, 0.6, 0.8]) {
  it(`un montículo de rocas de ${top} m: lo cruza por encima, con los pies sobre las rocas, sin resbalar`, () => {
    const world = createWorld({ buildTerrain: (t) => rocks(t, top) });
    const { human, terrain } = world;
    const loco = human.locomotion;
    const detector = new RaycastGroundDetector([terrain]);
    const hit = createGroundHit();
    const ground = (p: Vector3): number => (detector.castDown(new Vector3(p.x, p.y + 1, p.z), 3, hit) ? hit.point.y : -Infinity);
    let worstFoot = 0;
    let maxY = 0;
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    const r = simulate(world, 14, [[0, (h) => h.moveTo(new Vector3(0, 0, -8))]], {
      onFrame: () => {
        maxY = Math.max(maxY, human.position.y);
        for (const side of SIDES) {
          const foot = loco.feet[side];
          if (foot.phase !== 'PLANTED') continue;
          const sole = foot.planted.y - loco.planner.placement(side).ankleHeight;
          worstFoot = Math.max(worstFoot, ground(foot.planted) - sole);
        }
      },
    });
    assert.ok(arrived, 'no llegó');
    assert.ok(maxY > top - 0.05, `no subió (raíz a ${maxY.toFixed(2)} m)`);
    assert.ok(worstFoot < 0.025, `un pie apoyado se hundió ${(worstFoot * 100).toFixed(1)} cm en la roca`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, `deslizamiento ${r.slip}, IK ${r.stanceIK}, alterna ${r.alternates}`);
  });
}
});
