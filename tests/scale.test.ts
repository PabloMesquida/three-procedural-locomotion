import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import type { TerrainKind } from './helpers/terrains.ts';
import { ACCELERATION_PARAMS, defaultConfig, REFERENCE_LEG_LENGTH, SPEED_PARAMS } from '../src/index.ts';
import { createWorld, DEG, simulate, type Step } from './helpers/sim.ts';

/** Posiciones (raíz, caderas, pies) en cada frame, divididas por la escala. */
function normalizedTrajectory(s: number, terrain: TerrainKind, script: (k: number) => Step[], seconds: number): number[][] {
  const k = (x: number) => x * s;
  const world = createWorld({
    terrain,
    terrainScale: s,
    modelScale: s,
    // Semejanza geométrica (mismo reloj, velocidades y aceleraciones × s a mano): sin la escala de
    // velocidades automática.
    human: {
      speedScale: 'off',
      config: Object.fromEntries([...SPEED_PARAMS, ...ACCELERATION_PARAMS].map((p) => [p, k(defaultConfig[p])])),
    },
  });
  const frames: number[][] = [];
  const h = world.human;
  simulate(world, seconds, script(s), {
    onFrame: () => frames.push([h.position, h.rig.hips.getWorldPosition(new Vector3()), h.locomotion.feet.left.position, h.locomotion.feet.right.position].flatMap((v) => v.toArray()).map((x) => x / s)),
  });
  return frames;
}

function maxDifference(a: number[][], b: number[][]): number {
  let max = 0;
  a.forEach((f, i) => f.forEach((x, j) => { max = Math.max(max, Math.abs(x - b[i][j])); }));
  return max;
}

describe('tamaño del personaje (bodyScale)', () => {
  it('detecta la escala del modelo y deja la de referencia en 1 exacto', () => {
    assert.equal(createWorld().human.bodyScale, 1);
    const small = createWorld({ modelScale: 0.6 }).human;
    assert.ok(Math.abs(small.bodyScale - 0.6) < 1e-6 * 0.6); // relativo: el .glb guarda float32
    assert.ok(Math.abs(small.legLength - 0.6 * REFERENCE_LEG_LENGTH) < 1e-6 * small.legLength);
    assert.equal(createWorld({ modelScale: 0.6, human: { bodyScale: 1 } }).human.bodyScale, 1);
  });

  const flatScript = (s: number): Step[] => [
    [0, (h) => { h.targetSpeed = s * 1; }], [3, (h) => { h.targetSpeed = s * 3; }], [5, (h) => { h.targetHeading = 60 * DEG; }], [7, (h) => h.jump()],
    [8.5, (h) => { h.targetCrouch = 1; h.targetSpeed = s * 0.6; }], [11, (h) => { h.targetCrouch = 0; h.targetSpeed = 0; }], [13, (h) => h.moveTo(new Vector3(-4 * s, 0, -14 * s))],
  ];
  const bumpyScript = (s: number): Step[] => [[0, (h) => { h.targetSpeed = s * 1; }], [5.5, (h) => { h.targetSpeed = 0; }]];

  for (const [terrain, script, seconds] of [['flat', flatScript, 16], ['bumpy', bumpyScript, 8]] as const) {
    it(`semejanza en ${terrain}: a ×0,6 y ×1,5 (con velocidades escaladas) es una copia exacta a escala de ×1`, () => {
      const reference = normalizedTrajectory(1, terrain, script, seconds);
      for (const s of [0.6, 1.5]) {
        const diff = maxDifference(normalizedTrajectory(s, terrain, script, seconds), reference);
        assert.ok(diff < 1e-6, `×${s}: diferencia normalizada ${(diff * 1000).toFixed(4)} mm`);
      }
    });
  }

  for (const s of [0.6, 1.5]) {
    it(`×${s} con speedScale 'off' (velocidades sin adaptar al tamaño): camina, corre, salta y llega limpio`, () => {
      const world = createWorld({ modelScale: s, human: { speedScale: 'off' } });
      let arrived = false;
      world.human.on('arrive', () => { arrived = true; });
      const r = simulate(world, 20, [
        [0, (h) => { h.targetSpeed = 1; }], [3, (h) => { h.targetSpeed = 3; }], [6, (h) => h.jump()],
        [8, (h) => { h.targetSpeed = 0.5; h.targetCrouch = 1; }], [10, (h) => { h.targetCrouch = 0; h.moveTo(new Vector3(0, 0, h.position.z + 4)); }],
      ]);
      assert.ok(r.finiteOK && r.alternates, r.liftoffs);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 * s);
      assert.ok(r.toeClearance > -0.005 * s, `punta ${(r.toeClearance * 1000).toFixed(1)} mm`);
      assert.ok(arrived, 'no llegó');
      assert.equal(world.human.gaitMode, 'idle');
    });
  }
});

describe("velocidades según el tamaño (speedScale: 'auto')", () => {
  /**
   * Guion para un personaje a escala `s` con semejanza dinámica: velocidades × √s, distancias × s
   * y tiempos × √s. Con √s = 1 es el del personaje de referencia.
   */
  const script = (s: number): Step[] => {
    const r = Math.sqrt(s);
    const steps: Step[] = [
      [0, (h) => { h.targetSpeed = r * 1; }], [3, (h) => { h.targetSpeed = r * 3; }], [5, (h) => { h.targetHeading = 60 * DEG; }], [7, (h) => h.jump()],
      [8.5, (h) => { h.targetCrouch = 1; h.targetSpeed = r * 0.6; }], [11, (h) => { h.targetCrouch = 0; h.targetSpeed = 0; }], [13, (h) => h.moveTo(new Vector3(-4 * s, 0, -14 * s))],
    ];
    return steps.map(([t, action]) => [t * r, action]);
  };

  /** Posiciones (raíz, caderas, pies) divididas por la escala, frame a frame (60 frames por cada √s segundos). */
  const trajectory = (s: number, terrain: TerrainKind, seconds: number): number[][] => {
    const r = Math.sqrt(s);
    // bodyScale exacto: el medido sale del .glb (float32) con un error relativo de ~2e-8, y la altura
    // de las caderas con la pierna casi recta lo amplifica hasta décimas de mm en 16 s.
    const world = createWorld({ terrain, terrainScale: s, modelScale: s, human: { speedScale: 'auto', bodyScale: s } });
    const h = world.human;
    const frames: number[][] = [];
    simulate(world, seconds * r, script(s), {
      dt: r / 60,
      onFrame: () => frames.push([h.position, h.rig.hips.getWorldPosition(new Vector3()), h.locomotion.feet.left.position, h.locomotion.feet.right.position].flatMap((v) => v.toArray()).map((x) => x / s)),
    });
    return frames;
  };

  for (const terrain of ['flat', 'bumpy'] as const) {
    it(`semejanza dinámica en ${terrain}: a ×0,6 y ×1,5, con el tiempo × √s, es una copia exacta a escala de ×1`, () => {
      const seconds = terrain === 'flat' ? 16 : 8;
      const reference = trajectory(1, terrain, seconds);
      for (const s of [0.6, 1.5]) {
        const diff = maxDifference(trajectory(s, terrain, seconds), reference);
        assert.ok(diff < 1e-6, `×${s}: diferencia normalizada ${(diff * 1000).toFixed(4)} mm`);
      }
    });
  }

  it('velocidades en m/s reales: speedScale = √bodyScale, targetSpeed, speed y velocity convertidos', () => {
    const world = createWorld({ modelScale: 0.64, human: { speedScale: 'auto' } });
    const h = world.human;
    assert.ok(Math.abs(h.speedScale - 0.8) < 1e-6, `speedScale ${h.speedScale}`);
    h.targetSpeed = 0.7;
    assert.ok(Math.abs(h.targetSpeed - 0.7) < 1e-12);
    simulate(world, 5, []);
    assert.ok(Math.abs(h.speed - 0.7) < 0.01, `speed ${h.speed}`);
    assert.ok(Math.abs(h.velocity.length() - h.speed) < 1e-9);

    // Con 'off', el tamaño no cambia las velocidades.
    assert.equal(createWorld({ modelScale: 0.64, human: { speedScale: 'off' } }).human.speedScale, 1);
  });

  for (const s of [0.6, 1.5]) {
    it(`×${s}: a su velocidad de marcha da los pasos de su tamaño (÷ √s por segundo) y camina, corre, salta y llega limpio`, () => {
      const world = createWorld({ modelScale: s, human: { speedScale: 'auto' } });
      const h = world.human;
      let arrived = false;
      h.on('arrive', () => { arrived = true; });
      // Cadencia a su velocidad de marcha (walkSpeed × √s): stepFrequency ÷ √s.
      simulate(world, 4, [[0, (x) => { x.targetSpeed = x.config.walkSpeed * x.speedScale; }]]);
      const walk = simulate(world, 4, [], { start: 4 });
      const cadence = walk.liftoffs.length / 4;
      const expected = h.config.stepFrequency / Math.sqrt(s);
      assert.ok(Math.abs(cadence - expected) < 0.1 * expected, `cadencia ${cadence} pasos/s (esperada ${expected.toFixed(2)})`);
      const r = simulate(world, 20, [
        [8, (x) => { x.targetSpeed = 3; }], [11, (x) => x.jump()],
        [13, (x) => { x.targetSpeed = 0.5; x.targetCrouch = 1; }], [15, (x) => { x.targetCrouch = 0; x.moveTo(new Vector3(0, 0, x.position.z + 4)); }],
      ], { start: 8 });
      assert.ok(r.finiteOK && r.alternates, r.liftoffs);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 * s);
      assert.ok(r.toeClearance > -0.005 * s, `punta ${(r.toeClearance * 1000).toFixed(1)} mm`);
      assert.ok(arrived, 'no llegó');
      assert.equal(h.gaitMode, 'idle');
    });
  }
});
