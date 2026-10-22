import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultConfig, REFERENCE_LEG_LENGTH } from '../src/index.ts';
import { createWorld, DEG, simulate } from './helpers/sim.ts';

describe('agacharse', () => {
  it('quieto: baja las caderas lo configurado sin dar pasos, y se levanta a la pose inicial', () => {
    const world = createWorld();
    const { human } = world;
    simulate(world, 0.5);
    const standing = human.locomotion.pelvis.offset;
    const down = simulate(world, 2, [[0.5, (h) => { h.targetCrouch = 1; }]], { start: 0.5 });
    assert.equal(down.liftoffs, '', 'dio pasos al agacharse quieto');
    assert.ok(Math.abs(human.crouch - 1) < 1e-9);
    const drop = human.locomotion.pelvis.offset - standing;
    assert.ok(Math.abs(drop + defaultConfig.crouchDepth) < 0.03, `bajó ${(drop * 100).toFixed(1)} cm`);
    simulate(world, 2, [[2.5, (h) => { h.targetCrouch = 0; }]], { start: 2.5 });
    assert.ok(Math.abs(human.locomotion.pelvis.offset - standing) < 1e-6, 'no volvió a la altura inicial');
  });

  it('caminando y girando agachado: velocidad limitada y marcha limpia', () => {
    const world = createWorld();
    const r = simulate(world, 8, [[0, (h) => { h.targetCrouch = 1; }], [1, (h) => { h.targetSpeed = 2; }], [4, (h) => { h.targetHeading = 90 * DEG; }], [6, (h) => { h.targetSpeed = 0; }]]);
    assert.ok(r.maxSpeed <= defaultConfig.crouchMaxSpeed + 1e-9, `velocidad ${r.maxSpeed}`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
    assert.ok(r.hipDrop > -(defaultConfig.crouchDepth / REFERENCE_LEG_LENGTH) - 0.12, `caderas ${r.hipDrop.toFixed(3)} × pierna`);
    assert.equal(world.human.gaitMode, 'idle');
  });
});
