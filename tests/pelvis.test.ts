import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWorld, simulate } from './helpers/sim.ts';

const DEG = 180 / Math.PI;

/** Caída y giro de la pelvis (grados) frame a frame caminando a `speed`, y la fase del pie izquierdo. */
function record(speed: number) {
  const world = createWorld({ human: { config: { variation: 0 } } });
  const loco = world.human.locomotion;
  simulate(world, 3, [[0, (h) => { h.targetSpeed = speed; }]]);
  const roll: number[] = [];
  const yaw: number[] = [];
  const phase: number[] = [];
  simulate(world, 3, [], {
    start: 3,
    onFrame: () => {
      roll.push(loco.pelvis.angles.roll * DEG);
      yaw.push(loco.pelvis.angles.yaw * DEG);
      phase.push(loco.gait.footPhase('left'));
    },
  });
  return { roll, yaw, phase };
}

/** Frames en que la señal está prácticamente quieta (menos del 0,3 % de su recorrido por frame). */
function stillFrames(a: number[]): number {
  const range = Math.max(...a) - Math.min(...a);
  return a.slice(1).filter((x, i) => Math.abs(x - a[i]) < range * 0.003).length;
}

describe('pelvis: balanceo orgánico', () => {
  it('la caída lateral es una onda continua, no un interruptor que cambia en el doble apoyo (regresión)', () => {
    for (const speed of [0.5, 1]) {
      const { roll } = record(speed);
      // Antes: quieta ~80 % del tiempo (143 de 179 frames) y cambiaba de golpe.
      assert.ok(stillFrames(roll) < 25, `a ${speed} m/s quieta ${stillFrames(roll)} de ${roll.length - 1} frames`);
      assert.ok(Math.max(...roll) - Math.min(...roll) > 5, `a ${speed} m/s apenas cae`);
    }
  });

  it('la caída máxima llega poco después de cargar el peso, como en la marcha humana (~15–25 % del ciclo)', () => {
    const { roll, phase } = record(1);
    let best = -Infinity;
    let at = 0;
    for (let i = 0; i < roll.length; i++) {
      if (roll[i] > best) [best, at] = [roll[i], phase[i]];
    }
    assert.ok(at > 0.12 && at < 0.3, `máximo al ${(at * 100).toFixed(0)} % del ciclo`);
  });

  it('la rotación es continua (sin mesetas con los pies separados)', () => {
    const { yaw } = record(1);
    assert.ok(stillFrames(yaw) < 25, `rotación quieta ${stillFrames(yaw)} frames`);
  });
});
