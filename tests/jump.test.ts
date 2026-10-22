import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/index.ts';
import { createWorld, simulate } from './helpers/sim.ts';

const g = defaultConfig.gravity;
const v = defaultConfig.jumpSpeed;

describe('saltar', () => {
  it('quieto: altura y tiempo en el aire balísticos, eventos y vuelta a quieto', () => {
    const world = createWorld();
    const { human } = world;
    const events: string[] = [];
    let impact = 0;
    human.on('liftoff', () => events.push('liftoff'));
    human.on('land', (e) => { events.push('land'); impact = e.impactSpeed; });
    let apex = 0;
    let air = 0;
    const r = simulate(world, 3, [[0.5, (h) => assert.ok(h.jump())]], {
      onFrame: () => {
        if (human.airborne) { air += 1 / 60; apex = Math.max(apex, human.position.y); }
      },
    });
    assert.deepEqual(events, ['liftoff', 'land']);
    // Altura v²/2g y tiempo 2v/g, con el margen de la fracción de frame del despegue.
    assert.ok(Math.abs(apex - (v * v) / (2 * g)) < 0.04, `altura ${apex.toFixed(3)} m`);
    assert.ok(Math.abs(air - (2 * v) / g) < 0.04, `en el aire ${air.toFixed(3)} s`);
    assert.ok(Math.abs(impact - v) < 0.1, `impacto ${impact} m/s`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
    assert.equal(human.gaitMode, 'idle');
    assert.equal(human.jumpPhase, 'GROUNDED');
    assert.ok(Math.hypot(human.position.x, human.position.z) < 0.05, 'se desplazó al saltar quieto');
  });

  it('corriendo: salta ~2 m y sigue corriendo sin desplomarse (regresión: re-fasado del gait al aterrizar)', () => {
    const world = createWorld();
    const { human } = world;
    let takeoffZ = 0;
    let landZ = 0;
    human.on('liftoff', () => { takeoffZ = human.position.z; });
    human.on('land', () => { landZ = human.position.z; });
    const r = simulate(world, 6, [[0, (h) => { h.targetSpeed = 3; }], [3, (h) => h.jump()]]);
    // Distancia = velocidad horizontal × tiempo en el aire (2v/g).
    const distance = Math.abs(landZ - takeoffZ);
    assert.ok(Math.abs(distance - 3 * ((2 * v) / g)) < 0.1, `distancia ${distance.toFixed(2)} m`);
    assert.ok(Math.abs(human.speed - 3) < 1e-6, 'no siguió corriendo');
    assert.ok(r.hipDrop > -0.4, `caderas ${r.hipDrop.toFixed(3)} × pierna (el error antiguo llegaba a -0,88)`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('agachado: salta y vuelve a quedar agachado', () => {
    const world = createWorld();
    const { human } = world;
    const r = simulate(world, 5, [[0, (h) => { h.targetCrouch = 1; }], [1.5, (h) => assert.ok(h.jump())]]);
    assert.equal(human.jumpPhase, 'GROUNDED');
    assert.equal(human.gaitMode, 'idle');
    assert.ok(Math.abs(human.crouch - 1) < 1e-9);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('acepta un salto durante la amortiguación (encadenar) y lo rechaza durante la preparación o en el aire', () => {
    const world = createWorld();
    const { human } = world;
    let lands = 0;
    human.on('land', () => lands++);
    const results: string[] = [];
    simulate(world, 6, [[0.5, (h) => assert.ok(h.jump())]], {
      onFrame: () => {
        const phase = human.jumpPhase;
        if (phase === 'TAKEOFF' && !results.some((x) => x.startsWith('TAKEOFF'))) results.push(`TAKEOFF:${human.jump()}`);
        if (phase === 'AIRBORNE' && !results.some((x) => x.startsWith('AIRBORNE'))) results.push(`AIRBORNE:${human.jump()}`);
        if (phase === 'LANDING' && lands === 1 && !results.some((x) => x.startsWith('LANDING'))) results.push(`LANDING:${human.jump()}`);
      },
    });
    assert.deepEqual(results, ['TAKEOFF:false', 'AIRBORNE:false', 'LANDING:true']);
    assert.equal(lands, 2, 'el segundo salto no se completó');
    assert.equal(human.gaitMode, 'idle');
  });
});
