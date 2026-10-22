import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/index.ts';
import { angleDiff, createWorld, DEG, simulate } from './helpers/sim.ts';

describe('correr', () => {
  it('a 3 m/s: carrera completa con fase de vuelo, sin deslizar y con la cadencia configurada', () => {
    const world = createWorld();
    const { human } = world;
    simulate(world, 2.5, [[0, (h) => { h.targetSpeed = 3; }]]);
    let flight = 0;
    let frames = 0;
    const r = simulate(world, 4, [], {
      start: 2.5,
      onFrame: () => {
        frames++;
        if (human.footPhase('left') === 'SWING' && human.footPhase('right') === 'SWING') flight++;
      },
    });
    assert.ok(r.finiteOK && r.alternates, r.liftoffs);
    assert.ok(r.slip < 1e-6, `deslizamiento ${r.slip}`);
    assert.ok(r.stanceIK < 0.001, `IK ${r.stanceIK}`);
    assert.ok(human.runBlend > 0.99, `runBlend ${human.runBlend}`);
    assert.ok(flight / frames > 0.15, `fase de vuelo ${(100 * flight / frames).toFixed(0)} %`);
    const cadence = r.liftoffs.length / 4;
    assert.ok(Math.abs(cadence - defaultConfig.runStepFrequency) < 0.3, `cadencia ${cadence}`);
    assert.ok(r.hipDrop > -0.2, `caderas ${r.hipDrop.toFixed(3)} × pierna`);
    assert.ok(r.hipJerk < 0.025, `cambio brusco de caderas ${(r.hipJerk * 1000).toFixed(1)} mm/frame²`);
  });

  it('corriendo y girando 180° no se desploma (regresión: centro de apoyo en vuelo)', () => {
    const world = createWorld();
    const r = simulate(world, 8, [[0, (h) => { h.targetSpeed = 3; }], [2.5, (h) => { h.targetHeading = 180 * DEG; }]]);
    assert.ok(r.finiteOK && r.alternates, r.liftoffs);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
    assert.ok(r.hipDrop > -0.2, `caderas ${r.hipDrop.toFixed(3)} × pierna`);
    assert.ok(Math.abs(angleDiff(world.human.heading, 180 * DEG)) < 1 * DEG);
  });

  it('a 4,5 m/s con giros rápidos (120°/s) no se desploma: la aceleración lateral limita el giro (regresión)', () => {
    // Sin el límite (ω ≤ a/v), según el instante del giro las caderas caían hasta -0,7 × pierna.
    // El resultado depende de en qué momento del paso empieza el giro y de cómo caen los frames
    // sobre el paso (la bajada de caderas en la fase de vuelo es estrecha): se prueban 40
    // combinaciones y se exige el caso típico (p10) y un límite holgado para el peor.
    // Sin frenar para girar (turnSlowdown 0): se prueba el límite lateral a velocidad máxima. Frenando
    // desde 4,5 m/s se acentúa la bajada de caderas en la fase de vuelo (conocido, ver docs/en/development.md).
    const drops: number[] = [];
    for (const firstFrame of [0.25, 0.5, 0.75, 1]) {
      for (let k = 0; k < 10; k++) {
        const t0 = 4.5 + k * 0.07;
        const world = createWorld({ human: { config: { runSpeed: 4.5, turnSpeed: 120, turnAcceleration: 480, turnSlowdown: 0 } } });
        let first = true;
        const dt = (): number => {
          if (!first) return 1 / 60;
          first = false;
          return firstFrame / 60;
        };
        const r = simulate(world, t0 + 3, [[0, (h) => { h.targetSpeed = 4.5; }], [t0, (h) => { h.targetHeading = 90 * DEG; }]], { dt });
        assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
        drops.push(r.hipDrop);
      }
    }
    drops.sort((a, b) => a - b);
    assert.ok(drops[4] > -0.36, `caso típico (p10): caderas ${drops[4].toFixed(3)} × pierna`);
    assert.ok(drops[0] > -0.6, `peor caso: caderas ${drops[0].toFixed(3)} × pierna`);
  });

  it('en la pista irregular: sin deslizar y la punta salva los obstáculos', () => {
    const world = createWorld({ terrain: 'bumpy' });
    const r = simulate(world, 5, [[0, (h) => { h.targetSpeed = 3; }], [2.6, (h) => { h.targetSpeed = 1; }], [4.2, (h) => { h.targetSpeed = 0; }]]);
    assert.ok(r.finiteOK && r.alternates, r.liftoffs);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
    assert.ok(r.toeClearance > -0.005, `punta ${(r.toeClearance * 1000).toFixed(1)} mm`);
  });
});
