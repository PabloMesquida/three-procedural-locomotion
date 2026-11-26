import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExtrudeGeometry, Mesh, MeshBasicMaterial, type Object3D, Shape, Vector2, Vector3, BoxGeometry } from 'three';

import { createGroundHit, RaycastGroundDetector } from '../src/index.ts';
import { createWorld, simulate, type World } from './helpers/sim.ts';

// Pendientes (maxSlope): una meseta de 1,2 m (z de −6 a −3) a la que sube una rampa de `deg` grados hacia +Z.
const HEIGHT = 1.2;
const TOP_Z = -3;

function rampWorld(deg: number, config: Record<string, number> = {}): World {
  const run = HEIGHT / Math.tan((deg * Math.PI) / 180);
  const world = createWorld({
    human: { config },
    buildTerrain: (terrain: Object3D) => {
      const top = new Mesh(new BoxGeometry(3, HEIGHT, 3), new MeshBasicMaterial());
      top.position.set(0, HEIGHT / 2, TOP_Z - 1.5);
      terrain.add(top);
      const shape = new Shape([new Vector2(0, 0), new Vector2(0, HEIGHT), new Vector2(run, 0)]);
      const geometry = new ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: false });
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(0.7, 0, 0);
      const ramp = new Mesh(geometry, new MeshBasicMaterial());
      ramp.position.z = TOP_Z;
      terrain.add(ramp);
    },
  });
  world.model.position.set(0, 0, 5);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

/** Sube a la meseta y vuelve con moveTo: velocidad media y rodilla máxima (de la pierna en el aire) en la rampa. */
function upAndDown(deg: number): { up: { speed: number; knee: number }; down: { speed: number; knee: number }; top: boolean; back: boolean } {
  const world = rampWorld(deg);
  const { human } = world;
  const run = HEIGHT / Math.tan((deg * Math.PI) / 180);
  const stats = { up: { speed: 0, knee: 0, n: 0 }, down: { speed: 0, knee: 0, n: 0 } };
  let now: 'up' | 'down' = 'up';
  let top = false;
  const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
  simulate(world, 32, [[0.2, (h) => h.moveTo(new Vector3(0, HEIGHT, -5))], [14, (h) => { top = h.position.y > HEIGHT - 0.05; now = 'down'; h.moveTo(new Vector3(0, 0, 5)); }]], {
    onFrame: () => {
      const z = human.position.z;
      if (!(z > TOP_Z + 0.3 && z < TOP_Z + run - 0.3)) return;
      const s = stats[now];
      s.speed += human.speed;
      s.n++;
      for (const side of ['left', 'right'] as const) {
        if (human.footPhase(side) !== 'SWING') continue;
        const leg = human.rig[side];
        const thigh = p(leg.thigh), knee = p(leg.shin), ankle = p(leg.foot);
        s.knee = Math.max(s.knee, (knee.clone().sub(thigh).angleTo(ankle.clone().sub(knee)) * 180) / Math.PI);
      }
    },
  });
  const done = (s: { speed: number; knee: number; n: number }) => ({ speed: s.speed / Math.max(s.n, 1), knee: s.knee });
  return { up: done(stats.up), down: done(stats.down), top, back: human.position.distanceTo(new Vector3(0, 0, 5)) < 0.3 };
}

describe('pendientes (maxSlope)', () => {
  // Antes subía y bajaba una cara de roca de 30° a la velocidad y con la zancada del llano: 40–70 cm por paso, con las
  // rodillas al pecho (hasta 150°).
  for (const [deg, slowest, fastest] of [[20, 0.5, 1], [30, 0.35, 0.7]] as const) {
    it(`en una rampa de ${deg}°, sube y baja más despacio y con pasos más cortos (rodilla < 130°, como en una escalera)`, () => {
      const r = upAndDown(deg);
      assert.ok(r.top && r.back, `no llegó (${r.top ? 'arriba sí' : 'arriba no'}, ${r.back ? 'abajo sí' : 'abajo no'})`);
      for (const [name, s] of Object.entries({ subiendo: r.up, bajando: r.down })) {
        assert.ok(s.speed > slowest && s.speed < fastest, `${name}, a ${s.speed.toFixed(2)} m/s`);
        assert.ok(s.knee < 130, `${name}, rodilla a ${s.knee.toFixed(0)}°`);
      }
    });
  }

  it('una de 40° (más que maxSlope, 35°) no la sube: moveTo no va por ella y, de frente, se para al pie', () => {
    const route = rampWorld(40);
    simulate(route, 12, [[0.2, (h) => h.moveTo(new Vector3(0, HEIGHT, -5))]]);
    assert.ok(route.human.position.y < 0.2, `subió a ${route.human.position.y.toFixed(2)} m`);
    const straight = rampWorld(40);
    let highest = 0;
    simulate(straight, 8, [[0.2, (h) => { h.targetSpeed = 1.4; }]], { onFrame: () => { highest = Math.max(highest, straight.human.position.y); } });
    assert.ok(highest < 0.15, `subió a ${highest.toFixed(2)} m`);
    assert.ok(straight.human.speed < 0.05, `sigue a ${straight.human.speed.toFixed(2)} m/s`);
    assert.ok(straight.human.position.z > TOP_Z + 1.43 - 0.1, `se metió en la rampa (z = ${straight.human.position.z.toFixed(2)})`);
  });

  it('con maxSlope 90, la de 40° la sube', () => {
    const world = rampWorld(40, { maxSlope: 90 });
    // Despacio (ver SLOPE_STEP_RISE): a unos 0,25 m/s.
    simulate(world, 24, [[0.2, (h) => h.moveTo(new Vector3(0, HEIGHT, -5))]]);
    assert.ok(world.human.position.y > HEIGHT - 0.05, `se quedó a ${world.human.position.y.toFixed(2)} m`);
  });
});

// Como las laderas del Laboratorio: una meseta de 1,2 m con una rampa de 30° a un lado; bajando en diagonal desde la
// meseta, el pie caía más abajo de lo que alcanza su rayo (footProbeDepth) y se quedaba apoyado en el aire, hasta 66 cm
// por encima de la rampa, con la rodilla a 160–170° mientras el cuerpo seguía bajando. Y la pendiente bajo el cuerpo,
// medida en un paso, se tomaba por un borde (más de maxStepDown) desde los 27°: no frenaba.
describe('pendientes: bajar en diagonal', () => {
  it('bajando una rampa de 30° en diagonal desde la meseta: los pies, en el suelo, y la rodilla < 130°', () => {
    const world = createWorld({
      buildTerrain: (terrain: Object3D) => {
        const top = new Mesh(new BoxGeometry(8, HEIGHT, 2.5), new MeshBasicMaterial());
        top.position.set(-15, HEIGHT / 2, -3.75);
        terrain.add(top);
        const run = HEIGHT / Math.tan((30 * Math.PI) / 180);
        const shape = new Shape([new Vector2(0, 0), new Vector2(0, HEIGHT), new Vector2(run, 0)]);
        const geometry = new ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: false });
        geometry.rotateY(-Math.PI / 2);
        geometry.translate(0.7, 0, 0);
        const ramp = new Mesh(geometry, new MeshBasicMaterial());
        ramp.position.set(-13.4, 0, -2.5);
        terrain.add(ramp);
      },
    });
    const { human, terrain } = world;
    world.model.position.set(-16, HEIGHT, -4.5);
    world.model.updateMatrixWorld(true);
    human.reset();
    const detector = new RaycastGroundDetector([terrain]);
    const hit = createGroundHit();
    const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
    let floating = 0;
    let knee = 0;
    simulate(world, 14, [[0.2, (h) => h.moveTo(new Vector3(-13.4, 0, 1))]], {
      onFrame: () => {
        for (const side of ['left', 'right'] as const) {
          const foot = human.locomotion.feet[side];
          if (foot.phase === 'PLANTED' && detector.castDown(new Vector3(foot.planted.x, foot.planted.y + 1, foot.planted.z), 4, hit)) {
            floating = Math.max(floating, foot.planted.y - human.locomotion.planner.placement(side).ankleHeight - hit.point.y);
          }
          const leg = human.rig[side];
          const thigh = p(leg.thigh), k = p(leg.shin), ankle = p(leg.foot);
          knee = Math.max(knee, (k.clone().sub(thigh).angleTo(ankle.clone().sub(k)) * 180) / Math.PI);
        }
      },
    });
    assert.ok(human.position.distanceTo(new Vector3(-13.4, 0, 1)) < 0.2, `no llegó: ${human.position.toArray().map((v) => v.toFixed(2))}`);
    assert.ok(floating < 0.05, `un pie apoyado a ${(floating * 100).toFixed(0)} cm por encima del suelo`);
    assert.ok(knee < 130, `rodilla a ${knee.toFixed(0)}°`);
  });
});
