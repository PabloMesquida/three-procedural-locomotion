import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { ConfigError, defaultConfig, type StylePreset, stylePresets, validateConfig } from '../src/index.ts';
import { createWorld, horizontalDistance, simulate } from './helpers/sim.ts';

const names = Object.keys(stylePresets) as StylePreset[];

describe('estilos de marcha (presets)', () => {
  it('todos son configuraciones válidas', () => {
    for (const name of names) assert.doesNotThrow(() => validateConfig(stylePresets[name]), name);
  });

  it('se aplican al crear, y `config` manda sobre el estilo', () => {
    const { human } = createWorld({ human: { preset: 'tired', config: { walkSpeed: 0.9 } } });
    assert.equal(human.config.stepLength, stylePresets.tired.stepLength);
    assert.equal(human.config.walkSpeed, 0.9);
  });

  it('un estilo desconocido da un error claro', () => {
    assert.throws(() => createWorld({ human: { preset: 'zombie' as StylePreset } }), ConfigError);
  });

  it('applyPreset cambia de estilo en ejecución (incluida la anchura de paso) y "default" vuelve a los valores por defecto', () => {
    const { human } = createWorld();
    const width = () => {
      const p = human.locomotion.planner;
      return horizontalDistance(p.homePosition('left', new Vector3()), p.homePosition('right', new Vector3()));
    };
    const restWidth = width();
    human.applyPreset('heavy');
    assert.equal(human.config.lateralShift, stylePresets.heavy.lateralShift);
    assert.ok(Math.abs(width() - stylePresets.heavy.stepWidth) < 1e-9, `anchura ${width()}`);
    human.applyPreset('default');
    assert.deepEqual({ ...human.config }, { ...defaultConfig });
    assert.ok(Math.abs(width() - restWidth) < 1e-9);
  });

  for (const name of names) {
    it(`${name}: camina, corre, gira, salta y llega a un destino con una marcha limpia`, () => {
      const world = createWorld({ human: { preset: name } });
      const { human } = world;
      const c = human.config;
      let arrived = false;
      human.on('arrive', () => { arrived = true; });
      const r = simulate(world, 22, [
        [0, (h) => { h.targetSpeed = c.walkSpeed; }],
        [3, (h) => { h.targetSpeed = c.runSpeed; }],
        [5, (h) => { h.targetHeading = Math.PI / 2; }],
        [7, (h) => h.jump()],
        [9, (h) => h.moveTo(new Vector3(h.position.x - 4, 0, h.position.z + 2))],
      ]);
      assert.ok(r.finiteOK && r.alternates, r.liftoffs);
      assert.ok(r.slip < 1e-6, `deslizamiento ${r.slip}`);
      assert.ok(r.stanceIK < 0.001, `IK ${r.stanceIK}`);
      assert.ok(r.toeClearance > -0.005, `punta ${(r.toeClearance * 1000).toFixed(1)} mm`);
      assert.ok(r.hipDrop > -0.4, `caderas ${r.hipDrop.toFixed(3)} × pierna`);
      assert.ok(Math.abs(r.maxSpeed - c.runSpeed) < 1e-6, `velocidad máxima ${r.maxSpeed}`);
      assert.ok(arrived, 'no llegó al destino');
      assert.equal(human.gaitMode, 'idle');
    });
  }

  it('con un modelo escalado, la anchura del estilo se respeta en metros × bodyScale (regresión: escala de la raíz)', () => {
    const { human } = createWorld({ modelScale: 0.6, human: { preset: 'heavy' } });
    const p = human.locomotion.planner;
    const width = horizontalDistance(p.homePosition('left', new Vector3()), p.homePosition('right', new Vector3()));
    assert.ok(Math.abs(width - stylePresets.heavy.stepWidth * 0.6) < 1e-6 * 0.18, `anchura ${width}`);
  });
});
