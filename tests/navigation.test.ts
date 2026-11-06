import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Quaternion, Vector3 } from 'three';

import type { TerrainKind } from './helpers/terrains.ts';
import { createWorld, DEG, horizontalDistance, SIDES, simulate } from './helpers/sim.ts';

/** Va a `target` y comprueba: llega cerca, sin pasarse, una sola llegada, queda quieto pronto. */
function goTo(target: Vector3, options: { run?: boolean; seconds: number; terrain?: TerrainKind; tolerance?: number }) {
  const world = createWorld({ terrain: options.terrain });
  const { human } = world;
  const start = human.position.clone();
  const arrivals: number[] = [];
  let t = 0;
  human.on('arrive', () => arrivals.push(t));
  let overshoot = 0;
  let headingTravel = 0;
  let lastHeading = human.heading;
  const dir = target.clone().sub(start).setY(0);
  const length = dir.length();
  dir.normalize();
  const r = simulate(world, options.seconds, [[0, (h) => h.moveTo(target, { run: options.run })]], {
    onFrame: (time) => {
      t = time;
      overshoot = Math.max(overshoot, human.position.clone().sub(start).setY(0).dot(dir) - length);
      headingTravel += Math.abs(human.heading - lastHeading);
      lastHeading = human.heading;
    },
  });
  const error = horizontalDistance(human.position, target);
  assert.equal(arrivals.length, 1, `llegadas: ${arrivals.length}`);
  assert.ok(error < (options.tolerance ?? 0.1), `quedó a ${(error * 100).toFixed(1)} cm`);
  assert.ok(overshoot < 0.02, `se pasó ${(overshoot * 100).toFixed(1)} cm`);
  assert.equal(human.moveTarget, null);
  assert.equal(human.gaitMode, 'idle');
  assert.ok(r.idleTimes.at(-1)! - arrivals[0] < 2, `tardó ${(r.idleTimes.at(-1)! - arrivals[0]).toFixed(2)} s en quedarse quieto`);
  assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
  return { r, arrival: arrivals[0], headingTravel };
}

describe('point and click (moveTo)', () => {
  it('delante, caminando', () => {
    goTo(new Vector3(0, 0, -4), { seconds: 8 });
  });
  it('detrás: gira y vuelve', () => {
    goTo(new Vector3(0, 0, 3), { seconds: 10 });
  });
  it('a un lado', () => {
    goTo(new Vector3(-2, 0, 0), { seconds: 7 });
  });
  it('corriendo', () => {
    goTo(new Vector3(0, 0, -8), { run: true, seconds: 8 });
  });
  it('en diagonal, corriendo', () => {
    goTo(new Vector3(5, 0, -5), { run: true, seconds: 8 });
  });
  it('en la pista irregular', () => {
    goTo(new Vector3(0.2, 0, -6), { seconds: 10, terrain: 'bumpy' });
  });

  it('destino muy cerca y de lado: llega sin dar vueltas alrededor (regresión)', () => {
    const { headingTravel } = goTo(new Vector3(0.3, 0, -0.2), { seconds: 6, tolerance: 0.15 });
    assert.ok(headingTravel < 120 * DEG, `giró ${(headingTravel / DEG).toFixed(0)}° en total`);
  });

  it('al llegar se para como una persona: sin pasitos para cuadrar los pies y los brazos sin latigazo (regresión)', () => {
    // Antes: tras el paso de cierre daba otro de 6–15 cm para cuadrar los pies, y al quedar quieto la
    // pelvis volvía de golpe al centro y el codo se enderezaba en un frame (brazos a 60–540 °/s).
    for (const target of [new Vector3(3, 0, -3), new Vector3(0, 0, -5), new Vector3(-3, 0, 2), new Vector3(2, 0, 1)]) {
      const world = createWorld();
      const { human } = world;
      const arm = [human.rig.leftArm!.upperArm, human.rig.leftArm!.forearm, human.rig.leftArm!.hand, human.rig.rightArm!.forearm];
      const previous = arm.map((b) => b.getWorldQuaternion(new Quaternion()));
      let stopped = Number.POSITIVE_INFINITY;
      let armSpeed = 0;
      // Pasos ya parado: el de cierre (junta los pies) vale; uno corto solo para cuadrarlos, no.
      const last: Partial<Record<'left' | 'right', Vector3>> = {};
      const shuffles: number[] = [];
      human.on('footstep', ({ side, position }) => {
        const before = last[side];
        if (before && human.speed < 0.01) {
          const length = horizontalDistance(before, position);
          if (length < 0.17 * human.legLength) shuffles.push(length);
        }
        last[side] = position.clone();
      });
      const dt = 1 / 60;
      simulate(world, 8, [[0, (h) => h.moveTo(target)]], {
        dt,
        onFrame: (time) => {
          if (stopped === Number.POSITIVE_INFINITY && human.moveTarget === null && human.speed < 0.01) stopped = time;
          arm.forEach((bone, i) => {
            const q = bone.getWorldQuaternion(new Quaternion());
            if (time > stopped) armSpeed = Math.max(armSpeed, q.angleTo(previous[i]) / dt / DEG);
            previous[i].copy(q);
          });
        },
      });
      const where = `destino (${target.x}, ${target.z})`;
      assert.equal(shuffles.length, 0, `${where}: pasos cortos para cuadrar los pies tras pararse (${shuffles.map((l) => (l * 100).toFixed(1)).join(', ')} cm)`);
      assert.ok(armSpeed < 120, `${where}: brazos a ${armSpeed.toFixed(0)} °/s al quedar quieto`);
      assert.equal(human.gaitMode, 'idle');
    }
  });

  it('cambiar de destino en marcha y cancelar con control manual (sin evento de llegada)', () => {
    const world = createWorld();
    const { human } = world;
    let arrivals = 0;
    human.on('arrive', () => arrivals++);
    simulate(world, 2.5, [[0, (h) => h.moveTo(new Vector3(0, 0, -6))]]);
    simulate(world, 6, [[2.5, (h) => h.moveTo(new Vector3(3, 0, -2))]], { start: 2.5 });
    assert.equal(arrivals, 1);
    assert.ok(horizontalDistance(human.position, new Vector3(3, 0, -2)) < 0.1);

    simulate(world, 1, [[8.5, (h) => h.moveTo(new Vector3(-5, 0, -2))]], { start: 8.5 });
    human.targetSpeed = 0; // control manual: cancela
    simulate(world, 4, [], { start: 9.5 }); // con la variación natural puede dar un paso más
    assert.equal(human.moveTarget, null);
    assert.equal(arrivals, 1, 'emitió llegada al cancelar');
    assert.equal(human.gaitMode, 'idle');
  });
});

// Una plataforma de 1,02 m (más alta que maxStepUp, más honda que maxStepDown), de x 3 a 6,5 y de z −2 a 4, con
// una escalera de 17 × 28 cm en la cara de +X (z 1,9–3,3), como en el Laboratorio.
const PLATFORM = 1.02;
function platform(stairs: boolean): (terrain: Object3D) => void {
  const box = (t: Object3D, w: number, h: number, d: number, x: number, z: number): void => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
    mesh.position.set(x, h / 2, z);
    t.add(mesh);
  };
  return (t) => {
    box(t, 3.5, PLATFORM, 6, 4.75, 1);
    if (stairs) for (let k = 1; k < 6; k++) box(t, 0.28, 0.17 * k, 1.4, 6.5 + 0.28 * (5 - k + 0.5), 2.6);
  };
}
/** Cuánto se mete un punto en la plataforma, en planta (> 0: dentro; sin la escalera). */
const intoPlatform = (p: Vector3): number => Math.min(p.x - 3, 6.5 - p.x, p.z + 2, 4 - p.z);

describe('moveTo con ruta (rodea lo que no puede pisar)', () => {
  const run = (name: string, from: Vector3, target: Vector3, stairs: boolean) => {
    const world = createWorld({
      buildTerrain: platform(stairs),
      place: (model, scene) => { model.position.copy(from); scene.add(model); },
    });
    const { human } = world;
    let arrivals = 0;
    human.on('arrive', () => arrivals++);
    let route: Vector3[] | null = null;
    let slowest = Number.POSITIVE_INFINITY;
    let closest = Number.POSITIVE_INFINITY;
    let worstFoot = 0;
    simulate(world, 25, [[0, (h) => { h.moveTo(target); route = h.movePath; }]], {
      onFrame: (t) => {
        const p = human.position;
        // En la ruta, lejos todavía del destino (y pasado el arranque): no se para.
        if (t > 1.5 && human.moveTarget && horizontalDistance(p, human.moveTarget) > 1.2) slowest = Math.min(slowest, human.speed);
        // Abajo, lejos de la plataforma (no la toca para rodearla).
        if (p.y < 0.1) closest = Math.min(closest, -intoPlatform(p));
        for (const side of SIDES) {
          const foot = human.locomotion.feet[side];
          if (foot.phase === 'SWING') continue;
          const ground = foot.planted.y - human.locomotion.planner.placement(side).ankleHeight;
          if (intoPlatform(foot.planted) > 0.02) worstFoot = Math.max(worstFoot, Math.abs(ground - PLATFORM));
          else if (foot.planted.x < 6.5 || foot.planted.z < 1.9 || foot.planted.z > 3.3) worstFoot = Math.max(worstFoot, Math.abs(ground));
        }
      },
    });
    return { human, arrivals, route: route as Vector3[] | null, slowest, closest, worstFoot, name };
  };

  it('a un punto detrás de la plataforma: la rodea desde el principio, sin pararse, y llega', () => {
    const target = new Vector3(8.5, 0, 1);
    const r = run('rodear', new Vector3(1, 0, 1), target, true);
    assert.ok(r.route && r.route.length > 2, 'no planeó una ruta');
    assert.equal(r.arrivals, 1);
    assert.ok(horizontalDistance(r.human.position, target) < 0.1, `quedó a ${horizontalDistance(r.human.position, target).toFixed(2)} m`);
    // Sin pararse: en las curvas afloja un poco, como una persona.
    assert.ok(r.slowest > 0.7, `en la ruta bajó a ${r.slowest.toFixed(2)} m/s`);
    // Sin acercarse tanto como para frenar contra ella (lo que necesitan los pies, unos 21 cm).
    assert.ok(r.closest > 0.22, `pasó a ${r.closest.toFixed(2)} m de la plataforma`);
    assert.ok(r.worstFoot < 0.03, `un pie apoyó a ${r.worstFoot.toFixed(2)} m de su suelo`);
  });

  it('arriba de la plataforma: sube por la escalera', () => {
    const target = new Vector3(4.5, PLATFORM, 0);
    const r = run('subir', new Vector3(1, 0, 1), target, true);
    assert.equal(r.arrivals, 1);
    assert.ok(horizontalDistance(r.human.position, target) < 0.1 && Math.abs(r.human.position.y - PLATFORM) < 0.01, 'no llegó arriba');
    assert.ok(r.worstFoot < 0.03, `un pie apoyó a ${r.worstFoot.toFixed(2)} m de su suelo`);
  });

  it('desde arriba, abajo al otro lado: baja por la escalera', () => {
    const target = new Vector3(1, 0, -1);
    const r = run('bajar', new Vector3(4.5, PLATFORM, 0), target, true);
    assert.equal(r.arrivals, 1);
    assert.ok(horizontalDistance(r.human.position, target) < 0.1 && Math.abs(r.human.position.y) < 0.01, 'no llegó abajo');
    assert.ok(r.worstFoot < 0.03, `un pie apoyó a ${r.worstFoot.toFixed(2)} m de su suelo`);
  });

  it('arriba de una plataforma sin escalera: va al punto más cercano que alcanza y llega', () => {
    const target = new Vector3(4.5, PLATFORM, 0);
    const r = run('inalcanzable', new Vector3(0, 0, 0), target, false);
    assert.equal(r.arrivals, 1);
    assert.ok(Math.abs(r.human.position.y) < 0.01, 'subió');
    const gap = -intoPlatform(r.human.position);
    assert.ok(gap > 0.15 && gap < 0.6, `se paró a ${gap.toFixed(2)} m de la plataforma`);
  });

  it('con el camino libre va en línea recta (sin ruta), y con avoid: false también', () => {
    const world = createWorld({ buildTerrain: platform(true) });
    world.human.moveTo(new Vector3(-2, 0, -6));
    assert.equal(world.human.movePath, null);
    world.human.moveTo(new Vector3(8.5, 0, 1), { avoid: false });
    assert.equal(world.human.movePath, null);
  });

  it('followPath sigue los puntos dados con curvas y llega al último', () => {
    const world = createWorld();
    const { human } = world;
    let arrivals = 0;
    human.on('arrive', () => arrivals++);
    const points = [new Vector3(0, 0, -3), new Vector3(3, 0, -4), new Vector3(3, 0, -7)];
    let worst = 0;
    simulate(world, 12, [[0, (h) => h.followPath(points)]], {
      onFrame: () => {
        // Cerca del camino: a menos de medio metro de la poligonal.
        const p = human.position;
        let d = Number.POSITIVE_INFINITY;
        let a = new Vector3();
        for (const b of points) {
          const ab = b.clone().sub(a).setY(0);
          const t = Math.min(Math.max(p.clone().sub(a).setY(0).dot(ab) / ab.lengthSq(), 0), 1);
          d = Math.min(d, horizontalDistance(p, a.clone().addScaledVector(ab, t)));
          a = b;
        }
        worst = Math.max(worst, d);
      },
    });
    assert.equal(arrivals, 1);
    assert.ok(horizontalDistance(human.position, points[2]) < 0.1);
    assert.ok(worst < 0.5, `se apartó ${worst.toFixed(2)} m del camino`);
  });
});
