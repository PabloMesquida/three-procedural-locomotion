import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Group, Vector3 } from 'three';

import { createWorld, DEG, horizontalDistance, SIDES, simulate, type Step } from './helpers/sim.ts';

const route: Step[] = [
  [0, (h) => { h.targetSpeed = 1; }],
  [2, (h) => { h.targetHeading = 70 * DEG; }],
  [4, (h) => { h.targetSpeed = 3; }],
  [5.5, (h) => h.jump()],
  [7.5, (h) => { h.targetCrouch = 1; }],
  [9, (h) => { h.targetCrouch = 0; h.moveTo(new Vector3(-3, 0, -6)); }],
];

/** Puntos world de referencia del cuerpo. */
function bodyPoints(world: ReturnType<typeof createWorld>): Vector3[] {
  const r = world.human.rig;
  return [r.root, r.hips, r.left.foot, r.right.toe!, r.head!].map((o) => o.getWorldPosition(new Vector3()));
}

describe('API del personaje', () => {
  it('eventos: una pisada por cada aterrizaje de un pie', () => {
    const world = createWorld();
    const steps = { left: 0, right: 0 };
    world.human.on('footstep', (e) => { steps[e.side]++; });
    const r = simulate(world, 6, [[0, (h) => { h.targetSpeed = 1; }], [4, (h) => { h.targetSpeed = 0; }]]);
    const liftoffs = { left: [...r.liftoffs].filter((c) => c === 'L').length, right: [...r.liftoffs].filter((c) => c === 'R').length };
    for (const side of SIDES) assert.equal(steps[side], liftoffs[side], side);
  });

  it('on() devuelve la función para desuscribirse', () => {
    const world = createWorld();
    let n = 0;
    const off = world.human.on('footstep', () => n++);
    simulate(world, 1.5, [[0, (h) => { h.targetSpeed = 1; }]]);
    const before = n;
    off();
    simulate(world, 1.5, [], { start: 1.5 });
    assert.ok(before > 0);
    assert.equal(n, before);
  });

  it('varios personajes son independientes (configuración y movimiento)', () => {
    const a = createWorld({ human: { config: { runSpeed: 4 } } });
    const b = createWorld();
    a.human.setConfig({ walkSpeed: 0.6 });
    simulate(a, 4, [[0, (h) => { h.targetSpeed = 4; }]]);
    simulate(b, 4, [[0, (h) => { h.targetSpeed = 4; }]]);
    assert.equal(b.human.config.walkSpeed, 1.4);
    assert.equal(b.human.config.runSpeed, 3);
    assert.ok(Math.abs(a.human.speed - 4) < 1e-6 && Math.abs(b.human.speed - 3) < 1e-6);
  });

  it('dentro de un grupo movido, girado y escalado se mueve igual en el mundo que sin padre', () => {
    const free = createWorld({ place: (m, s) => { m.position.set(1.5, 0, 2); m.rotation.y = 30 * DEG; m.scale.setScalar(1.3); s.add(m); } });
    const nested = createWorld({
      place: (m, s) => {
        const group = new Group();
        group.position.set(1.5, 0, 2);
        group.rotation.y = 30 * DEG;
        group.scale.setScalar(1.3);
        s.add(group);
        group.add(m);
      },
    });
    let max = 0;
    const script = route;
    for (let i = 0; i < 16 * 60; i++) {
      const t = i / 60;
      for (const [time, action] of script) if (Math.abs(time - t) < 1e-9) { action(free.human); action(nested.human); }
      free.human.update(1 / 60);
      nested.human.update(1 / 60);
      const pa = bodyPoints(free);
      const pb = bodyPoints(nested);
      pa.forEach((p, k) => { max = Math.max(max, p.distanceTo(pb[k])); });
    }
    assert.ok(max < 1e-9, `diferencia ${max} m`);
    assert.ok(Math.abs(nested.human.bodyScale - 1.3) < 1e-6 * 1.3, `bodyScale ${nested.human.bodyScale}`); // relativo: el .glb guarda float32
  });

  it('el resultado no depende de los fps: 60, 20, irregulares y con un parón de 1 s', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const modes: Record<string, (t: number) => number> = {
      '60fps': () => 1 / 60,
      '20fps': () => 1 / 20,
      irregular: () => 1 / 144 + random() * (1 / 15 - 1 / 144),
      'parón': (t) => (t > 3 && t < 3.02 ? 1 : 1 / 60),
    };
    const finals: Record<string, Vector3> = {};
    for (const [name, dt] of Object.entries(modes)) {
      const world = createWorld({ terrain: 'bumpy' });
      let arrived = -1;
      world.human.on('arrive', () => { arrived = 1; });
      const r = simulate(world, 18, [[0, (h) => h.moveTo(new Vector3(0.3, 0, -6.5), { run: true })], [2.2, (h) => h.jump()], [4.5, (h) => h.moveTo(new Vector3(-0.4, 0, -1))]], { dt });
      assert.ok(r.finiteOK, name);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001, name);
      assert.equal(arrived, 1, `${name}: no llegó`);
      finals[name] = world.human.position.clone();
    }
    for (const name of Object.keys(modes)) {
      assert.ok(horizontalDistance(finals[name], finals['60fps']) < 0.05, `${name} terminó a ${(horizontalDistance(finals[name], finals['60fps']) * 100).toFixed(1)} cm`);
    }
  });

  it('teletransporte: mover el modelo y reset() lo deja quieto y apoyado allí', () => {
    const world = createWorld({ terrain: 'slopeSide' });
    simulate(world, 2, [[0, (h) => { h.targetSpeed = 1; }]]);
    world.model.position.set(2, 5, -3);
    world.human.reset();
    assert.ok(horizontalDistance(world.human.position, new Vector3(2, 0, -3)) < 1e-9);
    assert.ok(world.human.position.y < 1, 'no bajó al suelo');
    assert.equal(world.human.gaitMode, 'idle');
    const r = simulate(world, 1, [], { start: 2 });
    assert.equal(r.liftoffs, '');
    assert.ok(r.stanceIK < 0.001);
  });
});
