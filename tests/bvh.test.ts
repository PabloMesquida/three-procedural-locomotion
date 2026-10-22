import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { bvhForwardKinematics, loadBvh, parseBvh } from './helpers/bvh.ts';
import { analyzeGait } from './helpers/gaitAnalysis.ts';

/**
 * Lector de BVH de las herramientas de mocap (tests/helpers/bvh.ts, para las tomas de SFU). Con un
 * archivo mínimo escrito aquí; la toma real solo se prueba si está descargada (no se versiona, ver
 * docs/en/naturalness.md).
 */

const BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Arm
  {
    OFFSET 0 10 0
    CHANNELS 3 Xrotation Yrotation Zrotation
    JOINT Hand
    {
      OFFSET 0 0 10
      CHANNELS 3 Xrotation Yrotation Zrotation
      End Site
      {
        OFFSET 0 0 5
      }
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.008333
0 0 0 0 0 0 0 0 0 0 0 0
1 2 3 0 0 0 0 0 90 0 0 0
0 0 0 0 0 0 90 90 0 0 0 0
`;

const close = (a: Vector3, b: Vector3, label: string): void =>
  assert.ok(a.distanceTo(b) < 1e-6, `${label}: (${a.toArray().map((v) => v.toFixed(3))}) en vez de (${b.toArray()})`);

describe('lector de BVH (mocap de SFU)', () => {
  const motion = parseBvh(BVH);

  it('lee la jerarquía, los canales y los frames (los End Site no son articulaciones)', () => {
    assert.deepEqual(motion.joints.map((j) => j.name), ['Hips', 'Arm', 'Hand']);
    assert.deepEqual(motion.joints.map((j) => j.parent), [-1, 0, 1]);
    assert.deepEqual(motion.joints.map((j) => j.first), [0, 6, 9]);
    assert.equal(motion.frames.length, 3);
    assert.ok(Math.abs(motion.dt - 1 / 120) < 1e-5);
  });

  it('cinemática directa: offsets, posición de la raíz, escala y orden de las rotaciones', () => {
    const rest = bvhForwardKinematics(motion, 0.1);
    close(rest.get('Hand')!, new Vector3(0, 1, 1), 'reposo');
    // Raíz desplazada y Arm girado 90° en Z: el offset (0, 0, 10) de Hand no cambia, va con la raíz.
    const moved = bvhForwardKinematics(motion, 0.1, motion.frames[1]);
    close(moved.get('Arm')!, new Vector3(0.1, 1.2, 0.3), 'raíz');
    close(moved.get('Hand')!, new Vector3(0.1, 1.2, 1.3), 'raíz + giro en Z');
    // `Xrotation Yrotation Zrotation` es Rx·Ry·Rz: Ry(90) lleva (0, 0, 1) a (1, 0, 0) y Rx(90) lo deja
    // ahí (con el orden inverso acabaría en (0, -1, 0)).
    const ordered = bvhForwardKinematics(motion, 0.1, motion.frames[2]);
    close(ordered.get('Hand')!, new Vector3(1, 1, 0), 'orden X, Y, Z');
  });

  const take = 'recursos/mocap-sfu/0018_Walking001.bvh';
  it('una toma real de SFU da una marcha humana: pierna, cadencia y rodilla plausibles', { skip: existsSync(take) ? false : 'falta la toma (no se versiona)' }, () => {
    const series = loadBvh(take);
    assert.ok(series.legLength > 0.7 && series.legLength < 0.9, `pierna ${series.legLength.toFixed(3)} m`);
    const a = analyzeGait(series, 3, 7); // primer tramo recto
    assert.ok(a.cycles >= 3, `${a.cycles} ciclos`);
    assert.ok(a.scalars.cadence > 90 && a.scalars.cadence < 135, `cadencia ${a.scalars.cadence.toFixed(0)}`);
    assert.ok(Math.min(...a.curves.knee) < 10 && Math.max(...a.curves.knee) > 55, 'rodilla casi recta en el apoyo y ~60–70° en el vuelo');
  });
});
