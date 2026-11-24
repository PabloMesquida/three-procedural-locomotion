import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import type { ProceduralHuman, Side } from '../src/index.ts';
import { createWorld, SIDES, simulate, type World } from './helpers/sim.ts';

/** Altura de las plataformas (más de lo que baja de un paso: el hueco es un desnivel). */
const H = 1;

function box(parent: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, z);
  parent.add(mesh);
}

/**
 * Dos plataformas a 1 m separadas por un hueco de `width` m a lo ancho (de z = 0 a z = −width), y el personaje en la
 * primera, en z = `start`, mirando hacia el hueco (−Z).
 */
function gapWorld(width: number, start = 1.6, config: Record<string, number> = {}): World {
  const world = createWorld({
    buildTerrain: (g) => {
      box(g, 6, H, 12, 0, 0, 6);
      box(g, 6, H, 6, 0, 0, -width - 3);
    },
    human: { config },
  });
  world.model.position.set(0, H, start);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

interface Crossing {
  /** Lo más bajo que estuvo la raíz (m). */
  lowest: number;
  /** Pies apoyados más abajo que las plataformas (en el hueco). */
  inGap: number;
  /** Lo más que se separan los tobillos al aterrizar un pie (m). */
  longest: number;
  /** Lo más bajo de las caderas sobre la plataforma cerca del hueco (× largo de pierna). */
  hips: number;
  /** Lo más que la IK no llegó (m). */
  ik: number;
}

/** Simula `seconds` s dando `order` al empezar, y mide el cruce del hueco de `width` m. */
function cross(world: World, width: number, seconds: number, order: (h: ProceduralHuman) => void): Crossing {
  const { human } = world;
  const p = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
  const inAir: Record<Side, boolean> = { left: false, right: false };
  const r: Crossing = { lowest: Infinity, inGap: 0, longest: 0, hips: Infinity, ik: 0 };
  simulate(world, seconds, [[0, order]], {
    onFrame: () => {
      const s = human.locomotion.body.state;
      r.lowest = Math.min(r.lowest, s.position.y);
      if (s.position.z < 1.5 && s.position.z > -width - 1.5) r.hips = Math.min(r.hips, (p(human.rig.hips).y - H) / human.legLength);
      for (const side of SIDES) {
        const leg = (human.locomotion as unknown as { legs: Record<Side, { result: { error: number } | null }> }).legs[side].result;
        if (leg) r.ik = Math.max(r.ik, leg.error);
        const air = human.footPhase(side) === 'SWING';
        if (inAir[side] && !air) {
          const a = p(human.rig[side].foot);
          r.longest = Math.max(r.longest, a.distanceTo(p(human.rig[side === 'left' ? 'right' : 'left'].foot)));
          if (a.y < H - 0.02) r.inGap++;
        }
        inAir[side] = air;
      }
    },
  });
  return r;
}

describe('huecos (maxGapStep)', () => {
  for (const [width, speed, start] of [[0.3, 1.4, 1.6], [0.45, 1.4, 1.6], [0.45, 1.4, 10], [0.45, 0.6, 1.6], [0.3, 5, 10]] as const) {
    it(`cruza un hueco de ${width * 100} cm a ${speed} m/s${start > 5 ? ' (llegando a velocidad)' : ''}: un paso largo, sin pisar el hueco ni hundir las caderas`, () => {
      const world = gapWorld(width, start);
      const r = cross(world, width, start > 5 ? 9 + 10 / speed : 8, (h) => { h.targetHeading = 0; h.targetSpeed = speed; });
      const { human } = world;
      assert.ok(human.position.z < -width - 0.5 && human.position.y > H - 0.01, `no cruzó: (${human.position.z.toFixed(2)}, ${human.position.y.toFixed(2)})`);
      assert.ok(r.lowest > H - 0.01, `la raíz bajó a ${r.lowest.toFixed(2)} m`);
      assert.equal(r.inGap, 0, 'un pie apoyado en el hueco');
      // Caminando, un paso de 0,7 m; cruzando, como mucho algo más de lo que da al arrancar (0,8 m).
      assert.ok(r.longest < (speed > 3 ? 1 : 0.9), `un paso de ${r.longest.toFixed(2)} m`);
      // Caminando, las caderas a ~0,92 piernas de la plataforma: el paso largo las baja, pero poco.
      assert.ok(r.hips > 0.75, `las caderas bajaron a ${r.hips.toFixed(2)} piernas`);
      assert.ok(r.ik < 0.01, `la IK no llegó por ${(r.ik * 100).toFixed(1)} cm`);
    });
  }

  for (const [name, width, config] of [['más ancho que maxGapStep', 0.65, {}], ['con maxGapStep 0', 0.3, { maxGapStep: 0 }]] as const) {
    it(`${name}: se para en el borde, como ante un desnivel`, () => {
      const world = gapWorld(width, 1.6, config);
      const r = cross(world, width, 6, (h) => { h.targetHeading = 0; h.targetSpeed = 1.4; });
      const { human } = world;
      assert.ok(human.position.z > 0.05 && human.speed < 0.05, `no se paró antes del hueco: z ${human.position.z.toFixed(2)}, ${human.speed.toFixed(2)} m/s`);
      assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco');
    });
  }

  for (const target of [[0, -3], [1.5, -2], [2, -1]] as const) {
    it(`moveTo a (${target}), al otro lado de un hueco de 45 cm: lo cruza y llega`, () => {
      const world = gapWorld(0.45);
      const { human } = world;
      let arrived = false;
      human.on('arrive', () => { arrived = true; });
      const goal = new Vector3(target[0], H, target[1]);
      const r = cross(world, 0.45, 10, (h) => h.moveTo(goal));
      assert.ok(arrived && human.position.distanceTo(goal) < 0.3, `no llegó: (${human.position.x.toFixed(2)}, ${human.position.z.toFixed(2)})`);
      assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco o pisó en él');
      assert.ok(r.longest < 1.1, `un paso de ${r.longest.toFixed(2)} m`);
      assert.ok(r.hips > 0.75, `las caderas bajaron a ${r.hips.toFixed(2)} piernas`);
    });
  }

  it('moveTo al otro lado de un hueco más ancho que maxGapStep: no lo cruza, se queda en el borde más cercano', () => {
    const world = gapWorld(0.65);
    const { human } = world;
    const r = cross(world, 0.65, 8, (h) => h.moveTo(new Vector3(0, H, -3)));
    assert.ok(human.position.z > 0 && r.lowest > H - 0.01, `cruzó o cayó: (${human.position.z.toFixed(2)}, ${human.position.y.toFixed(2)})`);
    assert.ok(human.position.z < 0.6, `no se acercó al borde (z ${human.position.z.toFixed(2)})`);
  });
});
