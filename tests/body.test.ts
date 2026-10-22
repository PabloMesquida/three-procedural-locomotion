import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWorld, simulate } from './helpers/sim.ts';

/** Velocidad frame a frame al arrancar hasta 1,5 m/s y volver a parar. */
function speedProfile(speedEasing: number): number[] {
  const world = createWorld({ human: { config: { speedEasing } } });
  const speeds: number[] = [];
  simulate(world, 6, [[0.2, (h) => { h.targetSpeed = 1.5; }], [3, (h) => { h.targetSpeed = 0; }]], {
    onFrame: () => speeds.push(world.human.speed),
  });
  return speeds;
}

/** Máximo cambio de la aceleración (m/s³). */
function maxJerk(speeds: number[]): number {
  const acceleration = speeds.slice(1).map((v, i) => (v - speeds[i]) * 60);
  return Math.max(...acceleration.slice(1).map((a, i) => Math.abs(a - acceleration[i]) * 60));
}

describe('cuerpo: cambios de velocidad suaves (speedEasing)', () => {
  it('la aceleración y la frenada empiezan y terminan de forma gradual (curva en S)', () => {
    // Sin suavizado la aceleración se encendía y apagaba de golpe (150 m/s³).
    assert.ok(maxJerk(speedProfile(0)) > 100);
    const eased = speedProfile(0.35);
    assert.ok(maxJerk(eased) < 20, `cambio de aceleración ${maxJerk(eased).toFixed(1)} m/s³`);
    // Llega a la velocidad pedida y se para del todo.
    assert.ok(Math.abs(Math.max(...eased) - 1.5) < 1e-9 && eased[eased.length - 1] === 0);
  });

  it('la distancia de frenado prevista coincide con la real (point and click se detiene en el punto)', () => {
    const world = createWorld();
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 2; }]]);
    const predicted = world.human.locomotion.body.stoppingDistance();
    const start = world.human.position.clone();
    simulate(world, 3, [[3, (h) => { h.targetSpeed = 0; }]], { start: 3 });
    const actual = world.human.position.distanceTo(start);
    // El cuerpo avanza cada frame con la velocidad del final del frame: recorre ≈ v·dt/2 menos
    // que la curva continua (≈ 2 cm a 60 fps), dentro de la tolerancia de llegada.
    assert.ok(Math.abs(actual - predicted) < 0.03, `prevista ${predicted.toFixed(3)} m, real ${actual.toFixed(3)} m`);
  });
});
