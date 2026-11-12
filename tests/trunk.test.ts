import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

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

  // En las tomas de CMU (sujeto 83, que sube escaleras normales, y las de caminar), con cada paso la cabeza cabecea
  // ±1° (a ~11 °/s) y se ladea ±1,3°, y la línea de los hombros se inclina ±1° (RMS). Antes la cabeza estaba casi
  // quieta (±0,1°) y los hombros nivelados (±0,3°): se veía rígido; y con un muelle rápido, subiendo, cabeceaba a
  // 16 °/s: se veía sacudida. Subiendo, el tronco se inclina 7,5° más que en llano y la cabeza otro tanto (mira los
  // escalones); antes el tronco, 10°, y la cabeza, 2,7°.
  it('con cada paso la cabeza cabecea y se ladea y los hombros se inclinan; subiendo, el tronco y la cabeza se inclinan como en CMU', () => {
    const flat = posture(false);
    const up = posture(true);
    assert.ok(flat.nod > 0.3 && flat.nod < 1.5, `en llano, la cabeza cabecea ±${flat.nod.toFixed(2)}°`);
    assert.ok(flat.nodSpeed < 12 && up.nodSpeed < 12, `la cabeza cabecea a ${flat.nodSpeed.toFixed(1)} °/s en llano y a ${up.nodSpeed.toFixed(1)} subiendo`);
    assert.ok(flat.sway > 0.5 && flat.sway < 2, `en llano, la cabeza se ladea ±${flat.sway.toFixed(2)}°`);
    assert.ok(flat.shoulders > 0.6 && flat.shoulders < 1.6, `en llano, los hombros se inclinan ±${flat.shoulders.toFixed(2)}°`);
    assert.ok(up.nod > 0.3 && up.nod < 1.2, `subiendo, la cabeza cabecea ±${up.nod.toFixed(2)}°`);
    const trunk = up.trunk - flat.trunk;
    const head = up.head - flat.head;
    assert.ok(trunk > 5.5 && trunk < 9, `subiendo, el tronco se inclina ${trunk.toFixed(1)}° más que en llano`);
    assert.ok(head > 5.5 && head < 10, `subiendo, la cabeza se inclina ${head.toFixed(1)}° más que en llano`);
  });
});

/** Media móvil centrada (ventana de `n` muestras). */
function smooth(values: number[], n: number): number[] {
  const half = Math.floor(n / 2);
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1));
    return window.reduce((s, v) => s + v, 0) / window.length;
  });
}
/** RMS de lo que oscila con los pasos (sin la media móvil de 1 s, a 60 frames por segundo). */
const oscillation = (v: number[]): number => {
  const s = smooth(v, 60);
  return Math.sqrt(v.reduce((sum, x, i) => sum + (x - s[i]) ** 2, 0) / v.length);
};

/**
 * Caminando a 1 m/s, en llano o subiendo una escalera de 17 × 28 cm (hacia −Z): inclinación media del tronco
 * (pelvis → base del cuello) y de la cabeza (su "arriba" de reposo) hacia delante, y cuánto oscilan con los pasos
 * el cabeceo y el ladeo de la cabeza y la inclinación de la línea de los hombros (grados), de 3 a 8 s.
 */
function posture(stairs: boolean) {
  const world = createWorld({
    human: { config: { variation: 0 } },
    buildTerrain: (t) => {
      if (!stairs) return;
      for (let k = 1; k <= 24; k++) {
        const box = new Mesh(new BoxGeometry(1.6, 0.17 * k, 0.28), new MeshBasicMaterial());
        box.position.set(0, 0.085 * k, -2 - 0.28 * (k - 0.5));
        t.add(box);
      }
    },
  });
  const { human } = world;
  const rig = human.rig;
  const restUp = new Vector3(0, 1, 0).applyQuaternion(rig.head!.getWorldQuaternion(new Quaternion()).invert());
  const trunk: number[] = [];
  const pitch: number[] = [];
  const roll: number[] = [];
  const shoulders: number[] = [];
  simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }]], {
    onFrame: (t) => {
      if (t < 3) return;
      const F = human.locomotion.body.state.forward;
      const R = new Vector3().crossVectors(F, new Vector3(0, 1, 0));
      const up = rig.neck!.getWorldPosition(new Vector3()).sub(rig.hips.getWorldPosition(new Vector3()));
      trunk.push(Math.atan2(up.dot(F), up.y) * DEG);
      const head = restUp.clone().applyQuaternion(rig.head!.getWorldQuaternion(new Quaternion()));
      pitch.push(Math.atan2(head.dot(F), head.y) * DEG);
      roll.push(Math.atan2(head.dot(R), head.y) * DEG);
      const line = rig.leftArm!.upperArm.getWorldPosition(new Vector3()).sub(rig.rightArm!.upperArm.getWorldPosition(new Vector3()));
      shoulders.push(Math.asin(line.y / line.length()) * DEG);
    },
  });
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  // Velocidad del cabeceo (°/s, RMS).
  const speed = Math.sqrt(pitch.slice(1).reduce((s, x, i) => s + ((x - pitch[i]) * 60) ** 2, 0) / (pitch.length - 1));
  return { trunk: mean(trunk), head: mean(pitch), nod: oscillation(pitch), nodSpeed: speed, sway: oscillation(roll), shoulders: oscillation(shoulders) };
}

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
