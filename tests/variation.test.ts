import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { createWorld, simulate } from './helpers/sim.ts';

/** Longitudes (cm) de los pasos al caminar a 1 m/s durante 10 s, y el registro de la marcha. */
function walk(options: { seed?: number; variation?: number } = {}) {
  const world = createWorld({ human: { seed: options.seed, config: { variation: options.variation ?? 1 } } });
  const landings: Vector3[] = [];
  world.human.on('footstep', ({ position }) => landings.push(position.clone()));
  simulate(world, 3, [[0, (h) => { h.targetSpeed = 1; }]]);
  landings.length = 0;
  const recorder = simulate(world, 10, [], { start: 3 });
  const steps = landings.slice(1).map((p, i) => p.distanceTo(landings[i]) * 100);
  return { world, steps, recorder };
}

const std = (a: number[]): number => {
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
};

describe('variación natural', () => {
  it('sin variación todos los pasos son iguales; con ella varían un poco, como en una persona', () => {
    const exact = walk({ variation: 0 });
    const natural = walk();
    assert.ok(std(exact.steps) < 0.05, `sin variación: ${std(exact.steps).toFixed(2)} cm`);
    // Persona caminando: variabilidad de la longitud de paso de pocos cm.
    assert.ok(std(natural.steps) > 0.2 && std(natural.steps) < 4, `con variación: ${std(natural.steps).toFixed(2)} cm`);
  });

  it('no rompe la marcha: pies que no deslizan, IK exacto y pasos alternos', () => {
    const { recorder } = walk();
    assert.ok(recorder.slip < 1e-6 && recorder.stanceIK < 0.001 && recorder.alternates, recorder.liftoffs);
  });

  it('es determinista: la misma semilla repite el movimiento y otra semilla lo cambia', () => {
    const head = (seed: number): Vector3 => walk({ seed }).world.human.rig.head!.getWorldPosition(new Vector3());
    assert.ok(head(7).distanceTo(head(7)) < 1e-12, 'misma semilla, movimiento distinto');
    assert.ok(head(7).distanceTo(head(8)) > 0.001, 'semillas distintas, mismo movimiento');
  });

  it('los brazos no son un espejo exacto', () => {
    const world = createWorld();
    const arms = (world.human.locomotion.arms as unknown as { arms: { sign: number; angle: number }[] }).arms;
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 1; }]]);
    let left = 0;
    let right = 0;
    simulate(world, 8, [], {
      start: 3,
      onFrame: () => {
        for (const arm of arms) {
          if (arm.sign > 0) right = Math.max(right, arm.angle);
          else left = Math.max(left, -arm.angle);
        }
      },
    });
    assert.ok(Math.abs(left - right) > 0.002, `amplitudes izq/der ${left.toFixed(4)} / ${right.toFixed(4)} rad`);
  });
});
