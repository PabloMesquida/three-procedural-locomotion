import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { createWorld, simulate } from './helpers/sim.ts';

const DEG = 180 / Math.PI;

interface TorsoSprings {
  springs: Record<'spineYaw' | 'spineRoll' | 'spinePitch' | 'chestYaw', { value: number }>;
}

/** Giro de la pelvis, del pecho e inclinaciones del tronco (grados) frame a frame caminando a `speed`. */
function record(speed: number, config: Record<string, number> = {}) {
  const world = createWorld({ human: { config } });
  const loco = world.human.locomotion;
  const torso = loco.torso as unknown as TorsoSprings;
  simulate(world, 3, [[0, (h) => { h.targetSpeed = speed; }]]);
  const pelvis: number[] = [];
  const chest: number[] = [];
  const pitch: number[] = [];
  const roll: number[] = [];
  simulate(world, 3, [], {
    start: 3,
    onFrame: () => {
      pelvis.push(-loco.pelvis.angles.yaw * DEG);
      chest.push(torso.springs.chestYaw.value * DEG);
      pitch.push(torso.springs.spinePitch.value * DEG);
      roll.push(torso.springs.spineRoll.value * DEG);
    },
  });
  return { pelvis, chest, pitch, roll };
}

const range = (a: number[]): number => Math.max(...a) - Math.min(...a);
const maxJerk = (a: number[]): number => {
  const v = a.slice(1).map((x, i) => x - a[i]);
  return Math.max(...v.slice(1).map((x, i) => Math.abs(x - v[i])));
};

describe('tronco: peso y retraso', () => {
  it('el pecho sigue a la pelvis con un pequeño retraso, no como un bloque', () => {
    const { pelvis, chest } = record(1);
    let best = -Infinity;
    let lag = 0;
    for (let l = 0; l < 20; l++) {
      let c = 0;
      for (let i = 0; i + l < pelvis.length; i++) c += pelvis[i] * chest[i + l];
      if (c > best) [best, lag] = [c, l];
    }
    const ms = (lag / 60) * 1000;
    assert.ok(ms >= 20 && ms <= 120, `retraso ${ms.toFixed(0)} ms`);
  });

  it('se balancea con cada paso de forma suave y moderada', () => {
    const walk = record(1);
    assert.ok(range(walk.pitch) > 1 && range(walk.pitch) < 5, `avance/retroceso del tronco ${range(walk.pitch).toFixed(1)}°`);
    assert.ok(maxJerk(walk.pitch) < 0.8, `brusquedad ${maxJerk(walk.pitch).toFixed(2)}°/frame²`);
  });

  it('en el aire no se echa hacia atrás (en caída libre no hay inercia vertical)', () => {
    const world = createWorld();
    const torso = world.human.locomotion.torso as unknown as TorsoSprings;
    let back = 0;
    simulate(world, 3, [[0.5, (h) => h.jump()]], {
      onFrame: () => {
        if (world.human.airborne) back = Math.max(back, torso.springs.spinePitch.value * DEG);
      },
    });
    assert.ok(back < 4, `inclinación hacia atrás en el aire ${back.toFixed(1)}°`);
  });

  it('la cabeza apenas se va hacia los lados con cada paso (regresión: 9 cm con la compensación de la pelvis retrasada)', () => {
    // Persona caminando: la cabeza se desplaza unos 3–5 cm de lado a lado (en las tomas de caminar de
    // CMU, 4,8–5,3 cm con piernas como las del personaje).
    const walk = lateralSway(1);
    assert.ok(walk.head < 6, `caminando, cabeza de lado a lado ${walk.head.toFixed(1)} cm`);
    assert.ok(walk.tilt < 4, `caminando, inclinación lateral del tronco ${walk.tilt.toFixed(1)}°`);
    const run = lateralSway(3);
    assert.ok(run.head < 4, `corriendo, cabeza de lado a lado ${run.head.toFixed(1)} cm`);
    assert.ok(run.tilt < 5, `corriendo, inclinación lateral del tronco ${run.tilt.toFixed(1)}°`);
  });
});

/** Recorrido lateral de la cabeza (cm) e inclinación lateral del tronco (grados), de extremo a extremo. */
function lateralSway(speed: number): { head: number; tilt: number } {
  const world = createWorld({ human: { config: { variation: 0 } } });
  const { human } = world;
  simulate(world, 3, [[0, (h) => { h.targetSpeed = speed; }]]);
  const lateral: number[] = [];
  const tilt: number[] = [];
  simulate(world, 2, [], {
    start: 3,
    onFrame: () => {
      const F = human.locomotion.body.state.forward;
      const R = new Vector3().crossVectors(F, new Vector3(0, 1, 0));
      lateral.push(human.rig.head!.getWorldPosition(new Vector3()).sub(human.position).dot(R) * 100);
      const up = human.rig.neck!.getWorldPosition(new Vector3()).sub(human.rig.spine!.getWorldPosition(new Vector3())).normalize();
      tilt.push((Math.asin(up.dot(R)) * 180) / Math.PI);
    },
  });
  return { head: range(lateral), tilt: range(tilt) };
}
