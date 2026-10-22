import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Quaternion, Vector3 } from 'three';

import type { TerrainKind } from './helpers/terrains.ts';
import { createWorld, DEG, horizontalDistance, simulate } from './helpers/sim.ts';

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
