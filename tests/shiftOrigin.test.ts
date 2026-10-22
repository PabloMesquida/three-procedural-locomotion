import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Object3D, Vector3 } from 'three';

import type { TerrainKind } from './helpers/terrains.ts';
import type { ProceduralHuman } from '../src/index.ts';
import { createWorld, DEG, simulate, type Step, type World } from './helpers/sim.ts';

/** Puntos del cuerpo que se comparan: raíz, caderas, tobillos, cabeza y manos. */
function bodyPoints(world: World): Vector3[] {
  const h = world.human;
  const bones: (Object3D | undefined)[] = [h.rig.hips, h.rig.left.foot, h.rig.right.foot, h.rig.head, h.rig.leftArm?.hand, h.rig.rightArm?.hand];
  return [h.position.clone(), ...bones.filter((b): b is Object3D => b !== undefined).map((b) => b.getWorldPosition(new Vector3()))];
}

/** Recorrido con todo: caminar, correr, girar, saltar, agacharse, parar e ir a un punto (relativo a donde esté). */
const script: Step[] = [
  [0, (h) => { h.targetSpeed = 1; }], [3, (h) => { h.targetSpeed = 3; }], [5, (h) => { h.targetHeading = 90 * DEG; }],
  [6.5, (h) => h.jump()], [8, (h) => { h.targetSpeed = 0.6; h.targetCrouch = 1; }], [10, (h) => { h.targetCrouch = 0; h.targetSpeed = 0; }],
  [12, (h: ProceduralHuman) => h.moveTo(h.position.clone().add(new Vector3(-2, 0, 3)))],
];

/**
 * Simula el recorrido dos veces: tal cual, y desplazando cada frame con `shift` (que devuelve el
 * desplazamiento aplicado). Devuelve la mayor diferencia entre ambos, descontado lo desplazado.
 */
function compare(terrain: TerrainKind, seconds: number, shift: (world: World, frame: number) => Vector3): { diff: number; shifted: World } {
  const free = createWorld({ terrain, staticGround: false });
  const shifted = createWorld({ terrain, staticGround: false });
  const reference: Vector3[][] = [];
  simulate(free, seconds, script, { onFrame: () => reference.push(bodyPoints(free)) });
  const total = new Vector3();
  let frame = 0;
  let diff = 0;
  simulate(shifted, seconds, script, {
    onFrame: () => {
      bodyPoints(shifted).forEach((p, k) => { diff = Math.max(diff, p.sub(total).distanceTo(reference[frame][k])); });
      total.add(shift(shifted, frame));
      frame++;
    },
  });
  return { diff, shifted };
}

describe('shiftOrigin: desplazar al personaje sin cambiar su movimiento', () => {
  it('en el sitio (cinta de correr): cada frame vuelve a su punto y se mueve exactamente igual', () => {
    const start = new Vector3();
    let maxAway = 0;
    const { diff } = compare('flat', 16, (world) => {
      const h = world.human;
      const offset = new Vector3(start.x - h.position.x, 0, start.z - h.position.z);
      h.shiftOrigin(offset);
      maxAway = Math.max(maxAway, Math.hypot(h.position.x - start.x, h.position.z - start.z));
      return offset;
    });
    assert.ok(diff < 1e-6, `diferencia ${(diff * 1000).toFixed(4)} mm`);
    assert.ok(maxAway < 1e-9, `se alejó ${maxAway} m del punto`);
  });

  it('origen flotante: desplazar a la vez personaje y suelo (también en altura) no cambia el movimiento', () => {
    const offset = new Vector3(7, 1.5, -4);
    const { diff } = compare('bumpy', 8, (world, frame) => {
      if (frame % 45 !== 44) return new Vector3();
      world.terrain.position.add(offset);
      world.terrain.updateMatrixWorld(true);
      world.human.shiftOrigin(offset);
      return offset.clone();
    });
    assert.ok(diff < 1e-6, `diferencia ${(diff * 1000).toFixed(4)} mm`);
  });
});
