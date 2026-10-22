import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCELERATION_PARAMS,
  ConfigError,
  defaultConfig,
  LENGTH_PARAMS,
  PER_ACCELERATION_PARAMS,
  resolveConfig,
  scaleConfig,
  SPEED_PARAMS,
  validateConfig,
} from '../src/index.ts';
import { createWorld } from './helpers/sim.ts';

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  assert.fail('no lanzó ConfigError');
};

describe('configuración', () => {
  it('config parcial: cambia solo lo indicado y no toca los valores por defecto', () => {
    const c = resolveConfig({ walkSpeed: 1.2, jumpSpeed: 4 });
    assert.equal(c.walkSpeed, 1.2);
    assert.equal(c.jumpSpeed, 4);
    assert.equal(c.stepLength, defaultConfig.stepLength);
    assert.equal(defaultConfig.walkSpeed, 1.4);
    assert.ok(Object.isFrozen(defaultConfig));
  });

  it('rechaza nombres desconocidos (erratas) diciendo cuál', () => {
    assert.match(problemsOf(() => resolveConfig({ stepLenght: 0.8 } as never)).join(), /stepLenght/);
  });

  it('rechaza valores no numéricos; stepWidth admite null', () => {
    const problems = problemsOf(() => resolveConfig({ jumpSpeed: Number.NaN, walkSpeed: '1' as never }));
    assert.equal(problems.length, 2);
    assert.doesNotThrow(() => resolveConfig({ stepWidth: null }));
  });

  it('rechaza rangos que romperían el cálculo e incoherencias, todas a la vez', () => {
    const problems = problemsOf(() => resolveConfig({ gravity: -1, dutyFactor: 1.5, walkSpeed: 4, minStepFrequency: 3 }));
    assert.equal(problems.length, 4, problems.join('\n'));
  });

  it('validateConfig comprueba cambios sobre una base', () => {
    const base = resolveConfig({ runSpeed: 5 });
    assert.doesNotThrow(() => validateConfig({ walkSpeed: 4 }, base));
    assert.throws(() => validateConfig({ walkSpeed: 6 }, base), ConfigError);
  });

  it('scaleConfig multiplica solo las longitudes', () => {
    const c = scaleConfig(resolveConfig({ stepWidth: 0.2 }), 0.5);
    for (const key of LENGTH_PARAMS) assert.equal(c[key], (key === 'stepWidth' ? 0.2 : (defaultConfig[key] as number)) * 0.5, key);
    assert.equal(c.walkSpeed, defaultConfig.walkSpeed);
    assert.equal(c.gravity, defaultConfig.gravity);
    assert.equal(c.heelLiftAngle, defaultConfig.heelLiftAngle);
    assert.equal(scaleConfig(defaultConfig, 2).stepWidth, null);
  });

  it('scaleConfig geométrico: además velocidades y aceleraciones × escala, inclinaciones por aceleración ÷', () => {
    const c = scaleConfig(defaultConfig, 0.5, undefined, true);
    for (const key of LENGTH_PARAMS) if (key !== 'stepWidth') assert.equal(c[key], (defaultConfig[key] as number) * 0.5, key);
    for (const key of [...SPEED_PARAMS, ...ACCELERATION_PARAMS]) assert.equal(c[key], defaultConfig[key] * 0.5, key);
    for (const key of PER_ACCELERATION_PARAMS) assert.equal(c[key], defaultConfig[key] / 0.5, key);
    // Lo que no lleva metros, igual: frecuencias, tiempos, ángulos, fracciones.
    for (const key of ['stepFrequency', 'speedEasing', 'turnSpeed', 'heelLiftAngle', 'dutyFactor', 'landingAbsorb'] as const) {
      assert.equal(c[key], defaultConfig[key], key);
    }
  });

  it('setConfig: aplica en ejecución, es atómico si hay un error y avisa de los parámetros solo de creación', () => {
    const { human } = createWorld();
    human.setConfig({ walkSpeed: 0.7 });
    assert.equal(human.config.walkSpeed, 0.7);
    assert.equal(human.locomotion.config.walkSpeed, 0.7);
    assert.throws(() => human.setConfig({ walkSpeed: 0.5, dutyFactor: 2 }), ConfigError);
    assert.equal(human.config.walkSpeed, 0.7);

    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      human.setConfig({ kneePoleDistance: 0.5 });
      human.setConfig({ kneePoleDistance: 0.5 }); // mismo valor otra vez: sin aviso
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
  });

  it('opciones numéricas inválidas del constructor lanzan RangeError', () => {
    assert.throws(() => createWorld({ human: { bodyScale: -1 } }), RangeError);
    assert.throws(() => createWorld({ human: { maxTimeStep: 0 } }), RangeError);
  });
});
