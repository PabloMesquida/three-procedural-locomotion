import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import type { TerrainKind } from './helpers/terrains.ts';
import { createWorld, DEG, simulate, type Step } from './helpers/sim.ts';

/**
 * Referencias exactas ("golden"): escenarios fijos muestreados cada 0,1 s (raíz,
 * caderas, pies y cabeza). Cualquier cambio de comportamiento, aunque sea pequeño,
 * aparece aquí con el escenario, el instante y el punto que cambió.
 *
 * Si el cambio es intencionado (ajuste de parámetros, mejora), regenerar con:
 *   UPDATE_GOLDEN=1 npm test        (PowerShell: $env:UPDATE_GOLDEN=1; npm test)
 */
const GOLDEN_DIR = join('tests', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const TOLERANCE = 1e-6; // m
const POINTS = ['raíz', 'caderas', 'pie izq.', 'pie der.', 'cabeza'];

interface Scenario {
  terrain: TerrainKind;
  seconds: number;
  script: Step[];
}

const scenarios: Record<string, Scenario> = {
  'ruta-llano': {
    terrain: 'flat',
    seconds: 16,
    script: [
      [0, (h) => { h.targetSpeed = 1; }], [2, (h) => { h.targetHeading = 70 * DEG; }], [4, (h) => { h.targetSpeed = 3; }],
      [5.5, (h) => h.jump()], [7.5, (h) => { h.targetCrouch = 1; }], [9, (h) => { h.targetCrouch = 0; h.moveTo(new Vector3(-6, 0, -2)); }],
    ],
  },
  'pista-irregular': {
    terrain: 'bumpy',
    seconds: 8,
    // La pista mide 16 m (z de +8 a −8): el recorrido se queda dentro.
    script: [[0, (h) => { h.targetSpeed = 1; }], [3, (h) => { h.targetSpeed = 2; }], [3.8, (h) => h.jump()], [4.6, (h) => { h.targetSpeed = 0; }]],
  },
  'pendiente-lateral': {
    terrain: 'slopeSide',
    seconds: 7,
    script: [[0, (h) => { h.targetSpeed = 1; }], [2, (h) => { h.targetHeading = -45 * DEG; }], [4.5, (h) => { h.targetSpeed = 0; }]],
  },
  'giros-y-carrera': {
    terrain: 'flat',
    seconds: 10,
    script: [[0, (h) => { h.targetHeading = 180 * DEG; }], [4, (h) => { h.targetSpeed = 3; }], [6, (h) => { h.targetHeading = 0; }], [8, (h) => h.stop()]],
  },
};

function record(scenario: Scenario): number[][] {
  const world = createWorld({ terrain: scenario.terrain });
  const { human } = world;
  const rig = human.rig;
  const samples: number[][] = [];
  let frame = 0;
  simulate(world, scenario.seconds, scenario.script, {
    onFrame: () => {
      if (++frame % 6 !== 0) return;
      const points = [rig.root, rig.hips, rig.left.foot, rig.right.foot, rig.head!].map((o) => o.getWorldPosition(new Vector3()));
      samples.push(points.flatMap((p) => p.toArray()).map((x) => Math.round(x * 1e6) / 1e6));
    },
  });
  return samples;
}

// Grabadas con el modelo de referencia: con otro modelo (PH_MODEL) no aplican.
describe('referencias exactas (golden)', { skip: process.env.PH_MODEL ? 'grabadas con el modelo de referencia' : false }, () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, () => {
      const file = join(GOLDEN_DIR, `${name}.json`);
      const actual = record(scenario);
      if (UPDATE || !existsSync(file)) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ escenario: name, muestrasCada: '0.1 s', puntos: POINTS, muestras: actual })}\n`);
        console.log(`  referencia ${UPDATE ? 'actualizada' : 'creada'}: ${file}`);
        return;
      }
      const expected = (JSON.parse(readFileSync(file, 'utf8')) as { muestras: number[][] }).muestras;
      assert.equal(actual.length, expected.length, 'distinto número de muestras');
      for (let i = 0; i < expected.length; i++) {
        for (let j = 0; j < expected[i].length; j++) {
          const diff = Math.abs(actual[i][j] - expected[i][j]);
          if (diff > TOLERANCE) {
            assert.fail(
              `${name}: cambió el movimiento en t = ${((i + 1) * 0.1).toFixed(1)} s, ${POINTS[Math.floor(j / 3)]} (${'xyz'[j % 3]}): ` +
                `${(diff * 1000).toFixed(3)} mm (esperado ${expected[i][j]}, obtenido ${actual[i][j]}).\n` +
                '  Si el cambio es intencionado, regenera las referencias: UPDATE_GOLDEN=1 npm test',
            );
          }
        }
      }
    });
  }
});
