import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { defaultConfig } from '../src/index.ts';
import { angleDiff, createWorld, DEG, type Recorder, simulate, type World } from './helpers/sim.ts';

/** Comprobaciones comunes de cualquier marcha: pies que no deslizan, IK exacto, alternancia y punta despejada. */
function assertCleanGait(r: Recorder, toeMargin = -0.005): void {
  assert.ok(r.finiteOK, 'valores no finitos');
  assert.ok(r.slip < 1e-6, `un pie apoyado se deslizó ${(r.slip * 1000).toFixed(2)} mm`);
  assert.ok(r.stanceIK < 0.001, `error de IK en apoyo ${(r.stanceIK * 1000).toFixed(2)} mm`);
  assert.ok(r.alternates, `pasos no alternados: ${r.liftoffs}`);
  assert.ok(r.toeClearance > toeMargin, `la punta roza el suelo: ${(r.toeClearance * 1000).toFixed(1)} mm`);
}

describe('caminar en llano', () => {
  let world: World;
  let steady: Recorder;
  let stop: Recorder;
  before(() => {
    world = createWorld();
    simulate(world, 2, [[0, (h) => { h.targetSpeed = 1; }]]);
    steady = simulate(world, 4, [], { start: 2 });
    stop = simulate(world, 4, [[6, (h) => { h.targetSpeed = 0; }]], { start: 6 });
  });

  it('marcha limpia (sin deslizar, IK exacto, pies alternos, punta despejada)', () => {
    assertCleanGait(steady);
    assertCleanGait(stop);
  });

  it('alcanza la velocidad pedida con la cadencia configurada (±10 %)', () => {
    assert.ok(Math.abs(steady.maxSpeed - 1) < 1e-6);
    const cadence = steady.liftoffs.length / 4;
    assert.ok(Math.abs(cadence - defaultConfig.stepFrequency) < 0.2 * defaultConfig.stepFrequency * 0.5, `cadencia ${cadence} pasos/s`);
  });

  it('las caderas apenas bajan al caminar y no dan saltos', () => {
    assert.ok(steady.hipDrop > -0.1, `caderas ${steady.hipDrop.toFixed(3)} × pierna`);
    // Depende de cómo caen los frames sobre el paso (3,5–4,9 sin variación natural, hasta 5,2 con ella).
    assert.ok(steady.hipJerk < 0.006, `cambio brusco de caderas ${(steady.hipJerk * 1000).toFixed(1)} mm/frame²`);
  });

  it('las caderas no dan tirones en el doble apoyo a ninguna velocidad de marcha (regresión)', () => {
    // Antes: 9–11 mm/frame² caminando y 21 en la transición a correr. Venía de tres esquinas:
    // el pie aterrizaba a ~0,8 m/s arrastrando las caderas, el talón trasero se levantaba de
    // golpe en el doble apoyo y la pierna que limita la altura cambiaba en un frame.
    for (const [speed, limit] of [[0.3, 0.005], [0.5, 0.005], [0.8, 0.005], [1.2, 0.006], [1.4, 0.012]]) {
      const w = createWorld();
      simulate(w, 3, [[0, (h) => { h.targetSpeed = speed; }]]);
      const r = simulate(w, 3, [], { start: 3 });
      assert.ok(r.hipJerk < limit, `a ${speed} m/s: ${(r.hipJerk * 1000).toFixed(1)} mm/frame² (límite ${limit * 1000})`);
      assertCleanGait(r);
    }
  });

  it('los pies se mueven sin tirones, también al quedarse quieto (regresión: aplanado de los pies)', () => {
    // Normal ≈ 15 mm/frame²; aplanar los pies de golpe al entrar en idle daba 41.
    assert.ok(steady.footJerk < 0.025, `tirón de un pie ${(steady.footJerk * 1000).toFixed(1)} mm/frame²`);
    assert.ok(stop.footJerk < 0.025, `tirón de un pie al parar ${(stop.footJerk * 1000).toFixed(1)} mm/frame²`);
  });

  it('al parar queda quieto en menos de 2 s y con 3 pasos como mucho', () => {
    assert.equal(world.human.gaitMode, 'idle');
    assert.ok(stop.idleTimes.length > 0 && stop.idleTimes[0] - 6 < 2, `idle en ${stop.idleTimes[0]}`);
    assert.ok(stop.liftoffs.length <= 3, `pasos tras parar: ${stop.liftoffs}`);
  });
});

describe('girar en el sitio', () => {
  for (const angle of [90, 180]) {
    it(`${angle}°: llega al rumbo, alterna pies y queda quieto`, () => {
      const world = createWorld();
      const r = simulate(world, 7, [[0, (h) => { h.targetHeading = angle * DEG; }]]);
      assertCleanGait(r);
      assert.ok(Math.abs(angleDiff(world.human.heading, angle * DEG)) < 1 * DEG, `rumbo ${(world.human.heading / DEG).toFixed(1)}°`);
      assert.equal(world.human.gaitMode, 'idle');
      // Cada pie gira como mucho maxTurnPerStep por paso: el mínimo de pasos es angle / maxTurnPerStep.
      const minSteps = Math.ceil(angle / defaultConfig.maxTurnPerStep);
      assert.ok(r.liftoffs.length >= minSteps && r.liftoffs.length <= minSteps * 2 + 2, `pasos: ${r.liftoffs}`);
      assert.ok(Math.hypot(world.human.position.x, world.human.position.z) < 0.01, 'se desplazó al girar en el sitio');
    });
  }
});

describe('terreno inclinado e irregular', () => {
  for (const terrain of ['slopeSide', 'slopeFront'] as const) {
    it(`${terrain}: marcha limpia y queda quieto al parar`, () => {
      const world = createWorld({ terrain });
      const r = simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }], [4, (h) => { h.targetSpeed = 0; }]]);
      assertCleanGait(r);
      assert.equal(world.human.gaitMode, 'idle');
    });
  }

  it('pista irregular (baches, escalón, piedra): marcha limpia, la punta salva los obstáculos', () => {
    const world = createWorld({ terrain: 'bumpy' });
    const r = simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }], [5.5, (h) => { h.targetSpeed = 0; }]]);
    assertCleanGait(r);
    assert.ok(world.human.position.z < -5, 'no avanzó por la pista');
    assert.equal(world.human.gaitMode, 'idle');
  });
});
