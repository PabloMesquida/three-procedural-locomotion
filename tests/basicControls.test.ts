import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import {
  applyBasicControls,
  type BasicControls,
  basicControls,
  defaultConfig,
  neutralBasicControls,
  type ProceduralHumanConfig,
  stylePresets,
  validateConfig,
} from '../src/index.ts';
import { createWorld, simulate } from './helpers/sim.ts';

type Key = keyof ProceduralHumanConfig;

/** Parámetros cuyo valor cambia respecto a `base`. */
function changed(base: ProceduralHumanConfig, values: BasicControls): Key[] {
  const out = applyBasicControls(base, values);
  return (Object.keys(out) as Key[]).filter((key) => Math.abs((out[key] as number) - (base[key] as number)) > 1e-12);
}

/** Todos los controles en su mínimo o en su máximo a la vez. */
const allAt = (pick: 'min' | 'max'): BasicControls => Object.fromEntries(basicControls.map((c) => [c.name, c[pick]]));

/**
 * Combinaciones cuyo movimiento se prueba: cada control en su mínimo y en su máximo (todo su rango
 * está probado), y combinaciones realistas de varios. Todos a la vez en un extremo (p. ej. correr a
 * 4,8 m/s con zancada, reactividad e intensidad al máximo) solo se exige que sea una configuración
 * válida: como en el modo avanzado, extremos de todo a la vez pueden verse raros.
 */
const extremes: [string, BasicControls][] = [
  ...basicControls.flatMap((c): [string, BasicControls][] => [[`${c.name} = ${c.min}`, { [c.name]: c.min }], [`${c.name} = ${c.max}`, { [c.name]: c.max }]]),
  ['enérgico', { tempo: 1.3, stride: 1.1, stepHeight: 1.4, armSwing: 1.5, agility: 1.6, lean: 6, intensity: 1.4 }],
  ['tranquilo', { tempo: 0.7, stride: 0.85, stepHeight: 0.7, hipSway: 0.6, armSwing: 0.5, looseness: 1.5, agility: 0.6, intensity: 0.7 }],
];

describe('controles básicos (capa sobre la configuración)', () => {
  it('en su valor neutro no cambian nada (tampoco sobre un estilo)', () => {
    for (const base of [defaultConfig, { ...defaultConfig, ...stylePresets.heavy }] as ProceduralHumanConfig[]) {
      assert.deepEqual(changed(base, {}), []);
      assert.deepEqual(changed(base, neutralBasicControls), []);
    }
  });

  it('cada control tiene nombre y descripción en inglés y en español', () => {
    for (const control of basicControls) {
      for (const text of [control.label, control.description]) {
        assert.ok(text.en.trim() && text.es.trim() && text.en !== text.es, `${control.name}: ${JSON.stringify(text)}`);
      }
    }
  });

  it('cada control mueve exactamente los parámetros que declara', () => {
    for (const control of basicControls) {
      const value = control.neutral + (control.max - control.neutral) / 2;
      assert.deepEqual(changed(defaultConfig, { [control.name]: value }).sort(), [...control.params].sort(), control.name);
    }
  });

  it('los valores fuera de rango se recortan al rango del control', () => {
    for (const control of basicControls) {
      assert.deepEqual(applyBasicControls(defaultConfig, { [control.name]: control.max * 10 + 10 }), applyBasicControls(defaultConfig, { [control.name]: control.max }));
      assert.deepEqual(applyBasicControls(defaultConfig, { [control.name]: control.min - 100 }), applyBasicControls(defaultConfig, { [control.name]: control.min }));
    }
  });

  it('en los extremos la configuración siempre es válida', () => {
    for (const [name, values] of [...extremes, ['todos al mínimo', allAt('min')], ['todos al máximo', allAt('max')]] as const) {
      assert.doesNotThrow(() => validateConfig(applyBasicControls(defaultConfig, values)), name);
    }
  });

  for (const [name, values] of extremes) {
    it(`${name}: camina, corre, gira, salta y llega a un destino con una marcha limpia`, () => {
      const world = createWorld({ human: { config: applyBasicControls(defaultConfig, values) } });
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
      assert.ok(arrived, 'no llegó al destino');
      assert.equal(human.gaitMode, 'idle');
    });
  }
});
