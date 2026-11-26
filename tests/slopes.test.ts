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

// Como las laderas del Laboratorio: una meseta de 1,2 m con rampas estrechas de 20°, 30°, 40° y 50° que bajan de su
// frente. Bajando de la meseta a un punto pasada la de 30°, el planificador tomaba la esquina de suelo bajo entre la
// meseta y el costado de la rampa por un hueco que se cruza de un paso: la ruta pasaba unos centímetros fuera de la
// rampa, por encima del frente de la meseta. El personaje se paraba en el borde (~1,5 s), volvía a planear y bajaba con
// un paso de 1,5 m sobre la esquina: la rodilla a 172° y la cadera a 5 cm del suelo. Y llegando a la rampa en diagonal,
// entraba en ella a la velocidad del llano (zancadas de 1,2 a 1,5 m): no veía la pendiente por delante.
describe('pendientes: bajar de una meseta por una rampa estrecha', () => {
  const RAMPS = [[-11, 20], [-13.4, 30], [-15.8, 40], [-18.2, 50]] as const;
  const FRONT = -2.5;

  it('la ruta entra por la cresta de la de 30°, sin pararse al borde ni zancadas largas (rodilla < 130°, la cadera arriba)', () => {
    const world = createWorld({
      buildTerrain: (terrain: Object3D) => {
        const top = new Mesh(new BoxGeometry(8.7, HEIGHT, 2.5), new MeshBasicMaterial());
        top.position.set(-14.65, HEIGHT / 2, FRONT - 1.25);
        terrain.add(top);
        for (const [x, deg] of RAMPS) {
          const run = HEIGHT / Math.tan((deg * Math.PI) / 180);
          const shape = new Shape([new Vector2(0, 0), new Vector2(0, HEIGHT), new Vector2(run, 0)]);
          const geometry = new ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: false });
          geometry.rotateY(-Math.PI / 2);
          geometry.translate(0.7, 0, 0);
          const ramp = new Mesh(geometry, new MeshBasicMaterial());
          ramp.position.set(x, 0, FRONT);
          terrain.add(ramp);
        }
      },
    });
    const { human, terrain } = world;
    const start = new Vector3(-18, HEIGHT, -3.7);
    world.model.position.copy(start);
    world.model.updateMatrixWorld(true);
    human.reset();
    const target = new Vector3(-11, 0, 2);
    const detector = new RaycastGroundDetector([terrain]);
    const hit = createGroundHit();
    const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
    const hipsOverGround = (): number => {
      const hips = p(human.rig.hips);
      return detector.castDown(hips, 4, hit) ? hips.y - hit.point.y : Number.NaN;
    };
    const standing = hipsOverGround();
    let route: Vector3[] = [];
    let knee = 0;
    let hips = Number.POSITIVE_INFINITY;
    let stopped = 0;
    let moving = false;
    let stride = 0;
    const planted = { left: new Vector3(Number.NaN), right: new Vector3(Number.NaN) };
    simulate(world, 18, [[0.2, (h) => { h.moveTo(target); route = h.movePath ?? []; }]], {
      onFrame: () => {
        for (const side of ['left', 'right'] as const) {
          const leg = human.rig[side];
          const thigh = p(leg.thigh), k = p(leg.shin), ankle = p(leg.foot);
          knee = Math.max(knee, (k.clone().sub(thigh).angleTo(ankle.clone().sub(k)) * 180) / Math.PI);
          // Zancadas que bajan: de un apoyo del pie al siguiente, más abajo.
          const foot = human.locomotion.feet[side];
          if (foot.phase !== 'PLANTED') continue;
          const before = planted[side];
          if (!Number.isNaN(before.x) && foot.planted.y < before.y - 0.05) stride = Math.max(stride, Math.hypot(foot.planted.x - before.x, foot.planted.z - before.z));
          before.copy(foot.planted);
        }
        hips = Math.min(hips, hipsOverGround());
        // Parado lejos del destino, después de echar a andar.
        moving ||= human.speed > 0.5;
        if (moving && human.position.distanceTo(target) > 0.5 && human.speed < 0.1) stopped += 1 / 60;
      },
    });
    // Por dónde cruza la ruta el frente de la meseta: por la rampa de 30° (x de −14,1 a −12,7), lejos de sus costados.
    assert.ok(route.length > 0, 'sin ruta');
    let from = start;
    for (const q of route) {
      if ((from.z - FRONT) * (q.z - FRONT) < 0) {
        const x = from.x + ((q.x - from.x) * (FRONT - from.z)) / (q.z - from.z);
        assert.ok(x > -14.1 + 0.3 && x < -12.7 - 0.3, `la ruta cruza el frente de la meseta en x = ${x.toFixed(2)}`);
      }
      from = q;
    }
    assert.ok(human.position.distanceTo(target) < 0.2, `no llegó: ${human.position.toArray().map((v) => v.toFixed(2))}`);
    assert.ok(stopped < 0.3, `parado ${stopped.toFixed(1)} s antes de llegar`);
    // De frente, en la de 30° de arriba, hasta 1 m.
    assert.ok(stride < 1.05, `una zancada de ${stride.toFixed(2)} m bajando`);
    assert.ok(knee < 130, `rodilla a ${knee.toFixed(0)}°`);
    assert.ok(hips > 0.75 * standing, `la cadera bajó a ${hips.toFixed(2)} m del suelo (de pie, a ${standing.toFixed(2)} m)`);
  });
});
