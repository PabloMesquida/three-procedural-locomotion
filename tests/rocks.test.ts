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
// También despacio (walkSpeed 0,6): con pasos más cortos pisa más veces en los huecos entre rocas.
describe('rocas (terreno irregular sin escalones)', () => {
for (const [top, walkSpeed] of [[0.4], [0.6], [0.8], [0.4, 0.6], [0.6, 0.6], [0.8, 0.6]]) {
  const slow = walkSpeed === undefined ? '' : `, despacio (${walkSpeed} m/s)`;
  it(`un montículo de rocas de ${top} m${slow}: lo cruza por encima, con los pies sobre las rocas, sin resbalar`, () => {
    const world = createWorld({ buildTerrain: (t) => rocks(t, top), human: walkSpeed === undefined ? {} : { config: { walkSpeed } } });
    const { human, terrain } = world;
    const loco = human.locomotion;
    const detector = new RaycastGroundDetector([terrain]);
    const hit = createGroundHit();
    const ground = (p: Vector3): number => (detector.castDown(new Vector3(p.x, p.y + 1, p.z), 3, hit) ? hit.point.y : -Infinity);
    let worstFoot = 0;
    let maxY = 0;
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    const r = simulate(world, walkSpeed === undefined ? 14 : 24, [[0, (h) => h.moveTo(new Vector3(0, 0, -8))]], {
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
    // Por encima, no rodeándolo: sobre las rocas la raíz sigue la línea de los apoyos (ver StairPlanner), algo por debajo
    // de las cimas, y más despacio en la subida (ver SLOPE_STEP_RISE), un poco más baja: 0,66 m en el de 0,8.
    assert.ok(maxY > top - 0.2, `no subió (raíz a ${maxY.toFixed(2)} m)`);
    // Con el talón en el flanco de una roca, el pie se inclina y el tobillo se aparta de su rayo, sobre la roca de al
    // lado: FootPlacement mira también el suelo bajo él (antes, hasta 8 cm hundido en el de 0,8 a 0,6 m/s).
    assert.ok(worstFoot < 0.025, `un pie apoyado se hundió ${(worstFoot * 100).toFixed(1)} cm en la roca`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, `deslizamiento ${r.slip}, IK ${r.stanceIK}, alterna ${r.alternates}`);
  });
}
});

// Parado sobre las rocas, el cuerpo seguía la línea de la escalera (las rocas se ven como escalones) o el suelo bajo la
// raíz (una grieta entre dos rocas), por debajo de los dos pies: se quedaba con las dos rodillas dobladas, agachado
// (en estos destinos, la raíz quedaba de 8 a 13 cm por debajo del pie más bajo).
describe('rocas: parado sobre ellas', () => {
  for (const [top, x, z] of [[0.8, 0.4, -3.1], [0.6, 0.9, -2], [0.6, -0.4, -5], [0.8, -0.9, -4]] as const) {
    it(`parado en (${x}, ${z}) sobre un montículo de ${top} m: el cuerpo no queda por debajo del pie más bajo`, () => {
      const world = createWorld({ buildTerrain: (t) => rocks(t, top) });
      const { human } = world;
      const loco = human.locomotion;
      simulate(world, 12, [[0, (h) => h.moveTo(new Vector3(x, top, z))]]);
      const soles = SIDES.map((side) => loco.feet[side].planted.y - loco.planner.placement(side).ankleHeight);
      assert.equal(human.gaitMode, 'idle');
      // Hasta STAND_SLACK (0,03 × stepLength) por debajo, y algo más: en el llano no se mueve por milímetros.
      assert.ok(human.position.y > Math.min(...soles) - 0.04, `raíz a ${human.position.y.toFixed(2)} m, pies a ${soles.map((y) => y.toFixed(2)).join(' y ')}`);
    });
  }
});
