import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import type { ProceduralHuman, Side } from '../src/index.ts';
import { createWorld, simulate } from './helpers/sim.ts';

/** Flexión de la rodilla (grados, 0 = recta) medida en el esqueleto. */
function kneeAngle(human: ProceduralHuman, side: Side): number {
  const { thigh, shin, foot } = human.rig[side];
  const a = thigh.getWorldPosition(new Vector3());
  const b = shin.getWorldPosition(new Vector3());
  const c = foot.getWorldPosition(new Vector3());
  const upper = b.clone().sub(a).normalize();
  const lower = c.clone().sub(b).normalize();
  return (Math.acos(Math.min(1, upper.dot(lower))) * 180) / Math.PI;
}

describe('piernas: rodilla de apoyo', () => {
  it('amortigua al recibir el peso, se estira a mitad del apoyo y se flexiona antes de despegar (regresión: rodilla fija a 28°)', () => {
    const world = createWorld();
    const human = world.human;
    // A 1 m/s (marcha pura; por encima empieza la mezcla con correr, que baja las caderas a propósito).
    simulate(world, 4, [[0, (h) => { h.targetSpeed = 1; }]]);
    // Un apoyo completo del pie izquierdo: de aterrizar (PLANT) a despegar (SWING).
    const stance: number[] = [];
    let previous = human.footPhase('left');
    let recording = false;
    let done = false;
    simulate(world, 3, [], {
      start: 4,
      onFrame: () => {
        const phase = human.footPhase('left');
        if (!recording && phase === 'PLANT' && previous === 'SWING') recording = true;
        else if (recording && phase === 'SWING') done = true;
        previous = phase;
        if (recording && !done) stance.push(kneeAngle(human, 'left'));
      },
    });
    const at = (u: number): number => stance[Math.min(Math.round(u * stance.length), stance.length - 1)];
    const loading = Math.max(...stance.slice(0, Math.round(stance.length * 0.35)));
    const mid = Math.min(...stance.slice(Math.round(stance.length * 0.35), Math.round(stance.length * 0.7)));
    // Humano: ~5° al aterrizar, ~18° al cargar el peso, ~5° a mitad del apoyo, ~38° al despegar.
    assert.ok(loading - at(0) >= 4, `amortiguación: ${at(0).toFixed(1)}° → ${loading.toFixed(1)}°`);
    assert.ok(loading - mid >= 4, `vuelve a estirarse: ${loading.toFixed(1)}° → ${mid.toFixed(1)}°`);
    assert.ok(mid < 15, `a mitad del apoyo ${mid.toFixed(1)}°`);
    // Al despegar ya no carga peso: su flexión la pone la geometría del pie (Mixamo > 30°; el metarig de Rigify, ~29°).
    assert.ok(stance[stance.length - 1] > 25, `antes de despegar ${stance[stance.length - 1].toFixed(1)}°`);
  });

  it('de pie, las rodillas quedan casi rectas', () => {
    const world = createWorld();
    simulate(world, 1);
    for (const side of ['left', 'right'] as const) {
      assert.ok(kneeAngle(world.human, side) < 12, `${side}: ${kneeAngle(world.human, side).toFixed(1)}°`);
    }
  });
});
