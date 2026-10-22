import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { CurveName, GaitScalars } from './helpers/gaitAnalysis.ts';
import { analyzeHumanGait } from './helpers/humanLandmarks.ts';
import { createWorld, simulate } from './helpers/sim.ts';

/**
 * La marcha comparada con capturas de movimiento reales (CMU, ver docs/en/naturalness.md): medias por
 * ciclo de cuatro tomas de caminar normal, guardadas en tests/reference/cmu-caminar.json. El personaje
 * camina a la misma velocidad relativa (número de Froude) y se analiza igual que el mocap.
 *
 * Los límites son los resultados actuales con margen (también con el metarig de Rigify, de otras
 * proporciones: PH_MODEL): protegen lo conseguido. No se comparan las
 * curvas en las que el mocap de CMU se aparta de la literatura clínica (la rodilla, ~10° más doblada
 * en todo el ciclo; la caída lateral de la pelvis, con el máximo ~25 % más tarde) ni las que dependen
 * de cómo está construido cada esqueleto (inclinación del tronco y del cuello respecto al reposo).
 */
interface Reference {
  escalares: GaitScalars;
  curvas: Record<CurveName, number[]>;
}

const reference = JSON.parse(readFileSync('tests/reference/cmu-caminar.json', 'utf8')) as Reference;
const rms = (a: number[], b: number[]): number => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

describe('naturalidad: comparada con capturas de movimiento (CMU)', () => {
  const legLength = createWorld().human.legLength;
  const { analysis } = analyzeHumanGait(Math.sqrt(reference.escalares.froude * 9.81 * legLength));
  const s = analysis.scalars;
  const m = reference.escalares;

  it('ritmo y pasos: cadencia, zancada, apoyo y doble apoyo como los de una persona a esa velocidad', () => {
    assert.ok(Math.abs(s.cadence / m.cadence - 1) < 0.08, `cadencia ${s.cadence.toFixed(0)} (mocap ${m.cadence.toFixed(0)}) pasos/min`);
    assert.ok(Math.abs(s.strideLength / m.strideLength - 1) < 0.08, `zancada ${s.strideLength.toFixed(2)} (mocap ${m.strideLength.toFixed(2)}) × pierna`);
    assert.ok(Math.abs(s.stance - m.stance) < 0.03, `apoyo ${s.stance.toFixed(2)} (mocap ${m.stance.toFixed(2)})`);
    assert.ok(Math.abs(s.doubleSupport - m.doubleSupport) < 0.05, `doble apoyo ${s.doubleSupport.toFixed(2)} (mocap ${m.doubleSupport.toFixed(2)})`);
    assert.ok(s.toeClearance > 0.01 && s.toeClearance < 0.07, `holgura de la punta ${s.toeClearance.toFixed(3)} × pierna (mocap ${m.toeClearance.toFixed(3)})`);
  });

  // Error cuadrático medio máximo frente a la curva media del mocap a lo largo del ciclo.
  const limits: [CurveName, number, string][] = [
    ['thigh', 8, '°'],
    ['knee', 12, '°'],
    ['ankle', 7, '°'],
    ['footPitch', 8, '°'],
    ['ankleAhead', 0.04, ' × pierna'],
    ['pelvisYaw', 3, '°'],
    ['trunkYaw', 3, '°'],
    ['arm', 7, '°'],
    ['elbow', 8, '°'],
    ['pelvisPitch', 0.8, '°'],
    ['shoulderRoll', 2, '°'],
    ['armCross', 3.5, '°'],
    ['forearmCross', 3, '°'],
  ];
  for (const [curve, limit, unit] of limits) {
    it(`curva ${curve}: dentro de ${limit}${unit} de la del mocap`, () => {
      const error = rms(analysis.curves[curve], reference.curvas[curve]);
      assert.ok(error < limit, `${curve}: ${error.toFixed(3)}${unit}`);
    });
  }

  it('camina (no corre) a paso vivo: una persona no empieza a correr hasta cerca de 2 m/s (Froude ≈ 0,5)', () => {
    const world = createWorld();
    simulate(world, 5, [[0, (h) => { h.targetSpeed = 1.7; }]]);
    assert.equal(world.human.locomotion.gait.blend, 0);
    simulate(world, 5, [[5, (h) => { h.targetSpeed = 2.6; }]], { start: 5 });
    assert.equal(world.human.locomotion.gait.blend, 1);
  });
});
