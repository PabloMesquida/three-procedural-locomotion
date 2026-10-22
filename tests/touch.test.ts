import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, CylinderGeometry, Mesh, MeshBasicMaterial, type Object3D, Quaternion, Raycaster, Vector3 } from 'three';

import { ACCELERATION_PARAMS, defaultConfig, PER_ACCELERATION_PARAMS, type ProceduralHuman, SPEED_PARAMS } from '../src/index.ts';
import type { Side } from '../src/rig/HumanRig.ts';
import { createWorld, DEG, horizontalDistance, simulate, type World } from './helpers/sim.ts';

const UP = new Vector3(0, 1, 0);

type Kind = 'columna' | 'pared' | 'baranda';

/**
 * Pone una columna (cilindro de 15 cm de radio), una pared (8 m a lo largo del camino) o una baranda
 * (barra de 8 × 6 cm a 1 m de altura) a un lado del camino, `lateral` m del centro del personaje,
 * y la hace tocable. Medidas del personaje de referencia (× `s`).
 */
function addSurface(world: World, kind: Kind, side: Side, lateral: number, ahead: number, s = 1): Object3D {
  const { human } = world;
  const forward = human.locomotion.body.state.forward.clone();
  const out = new Vector3().crossVectors(forward, UP).multiplyScalar(side === 'right' ? 1 : -1);
  const geometry = kind === 'columna' ? new CylinderGeometry(0.15 * s, 0.15 * s, 2.5 * s, 24) : kind === 'pared' ? new BoxGeometry(0.2 * s, 2.5 * s, 8 * s) : new BoxGeometry(0.08 * s, 0.06 * s, 8 * s);
  const object = new Mesh(geometry, new MeshBasicMaterial());
  object.position.copy(human.position).addScaledVector(forward, ahead * s).addScaledVector(out, lateral * s);
  object.position.y = (kind === 'baranda' ? 1 : 1.25) * s;
  if (kind !== 'columna') object.lookAt(object.position.clone().add(forward));
  world.scene.add(object);
  object.updateMatrixWorld(true);
  human.touchables = [object];
  return object;
}

interface TouchRun {
  touches: { side: Side; point: Vector3; t: number }[];
  /** Lo que se mueve la muñeca apoyada (m) y lo más que se separa el centro de la palma de la superficie (m). */
  drift: number;
  palmGap: number;
  /** Lo que camina el cuerpo con la mano apoyada (m). */
  contactDistance: number;
  /** Palma · normal de la superficie apoyada (−1 = la palma mira la superficie). */
  palmFacing: number;
  /** Mayor aceleración angular de brazo, antebrazo o mano (°/frame²). */
  jerk: number;
  /** Fases por las que pasó la mano que tocó. */
  phases: string[];
}

/**
 * Normal de la palma (hacia el lado de la palma), world: la que mide el controlador en la pose de reposo
 * (con los dedos, si el rig los tiene; si no, la palma hacia abajo en la T).
 */
function palmNormal(human: ProceduralHuman, side: Side): Vector3 {
  const hand = (human.locomotion.touch as unknown as { hands: Record<Side, { palmLocal: Vector3 }> }).hands[side];
  const arm = human.rig[side === 'left' ? 'leftArm' : 'rightArm']!;
  return hand.palmLocal.clone().applyQuaternion(arm.hand.getWorldQuaternion(new Quaternion()));
}

/** Centro de la palma (world) y su normal, como los mide el controlador. */
function palm(human: ProceduralHuman, side: Side): { center: Vector3; normal: Vector3 } {
  const hand = (human.locomotion.touch as unknown as { hands: Record<Side, { fingerLocal: Vector3; palmLocal: Vector3; palmLength: number; palmThickness: number }> }).hands[side];
  const arm = human.rig[side === 'left' ? 'leftArm' : 'rightArm']!;
  const q = arm.hand.getWorldQuaternion(new Quaternion());
  const normal = hand.palmLocal.clone().applyQuaternion(q);
  const center = arm.hand.getWorldPosition(new Vector3()).addScaledVector(hand.fingerLocal.clone().applyQuaternion(q), hand.palmLength).addScaledVector(normal, hand.palmThickness);
  return { center, normal };
}

/** Camina a `speed` m/s y registra el gesto (con `surface`, también lo que se separa la palma de ella). */
function walkPast(world: World, speed: number, seconds = 7, normal?: (point: Vector3) => Vector3, surface?: Object3D): TouchRun {
  const { human } = world;
  const run: TouchRun = { touches: [], drift: 0, palmGap: 0, contactDistance: 0, palmFacing: -1, jerk: 0, phases: [] };
  const ray = new Raycaster();
  let contactStart: Vector3 | null = null;
  let now = 0;
  human.on('touch', ({ side, point }) => run.touches.push({ side, point, t: now }));
  const previous: Record<Side, { q: Quaternion[]; w: number[]; phase: string; contact: Vector3 | null }> = {
    left: { q: [], w: [], phase: 'none', contact: null },
    right: { q: [], w: [], phase: 'none', contact: null },
  };
  simulate(world, seconds, [[0, (h) => { h.targetSpeed = speed; }]], {
    onFrame: (t) => {
      now = t;
      for (const side of ['left', 'right'] as const) {
        const arm = human.rig[side === 'left' ? 'leftArm' : 'rightArm']!;
        const p = previous[side];
        const phase = human.touchPhase(side);
        if (phase !== p.phase) {
          if (run.phases.at(-1) !== phase) run.phases.push(phase);
          p.phase = phase;
        }
        const qs = [arm.upperArm, arm.forearm, arm.hand].map((b) => b.getWorldQuaternion(new Quaternion()));
        const w = qs.map((q, i) => (p.q[i] ? (2 * Math.acos(Math.min(1, Math.abs(q.dot(p.q[i]))))) / DEG : 0));
        if (p.w.length > 0 && t > 0.3) w.forEach((x, i) => { run.jerk = Math.max(run.jerk, Math.abs(x - p.w[i])); });
        p.q = qs;
        p.w = w;
        const wrist = arm.hand.getWorldPosition(new Vector3());
        if (phase === 'contact') {
          if (p.contact) run.drift = Math.max(run.drift, wrist.distanceTo(p.contact));
          else p.contact = wrist;
          contactStart ??= human.position.clone();
          run.contactDistance = Math.max(run.contactDistance, horizontalDistance(human.position, contactStart));
          if (surface) {
            const { center, normal: n } = palm(human, side);
            ray.set(center.clone().addScaledVector(n, -0.2), n);
            const hit = ray.intersectObject(surface)[0];
            run.palmGap = Math.max(run.palmGap, hit ? Math.abs(hit.distance - 0.2) : 1);
          }
          const touch = run.touches.at(-1);
          if (touch && normal) run.palmFacing = Math.max(run.palmFacing, palmNormal(human, side).dot(normal(touch.point)));
        } else p.contact = null;
      }
    },
  });
  return run;
}

describe('tocar superficies al pasar (touchables)', () => {
  for (const side of ['left', 'right'] as const) {
    it(`columna a la ${side === 'left' ? 'izquierda' : 'derecha'}: la toca una vez con la palma, sin tirones, y la suelta`, () => {
      const world = createWorld({ human: { config: { variation: 0 } } });
      const column = addSurface(world, 'columna', side, 0.6, 3);
      // Normal de la superficie en el punto tocado: del eje de la columna hacia fuera.
      const run = walkPast(world, 1.2, 7, (point) => point.clone().sub(column.position).setY(0).normalize());
      assert.equal(run.touches.length, 1, `${run.touches.length} toques`);
      assert.equal(run.touches[0].side, side);
      assert.deepEqual(run.phases, ['reach', 'contact', 'release', 'none']);
      // Muy curva: no la desliza (la toca y la suelta al pasar); la mano apoyada no se mueve, con la palma
      // hacia la columna.
      assert.ok(run.drift < 0.001, `la mano apoyada se mueve ${(run.drift * 1000).toFixed(1)} mm`);
      assert.ok(run.palmFacing < -0.85, `palma · normal ${run.palmFacing.toFixed(2)}`);
      // El brazo pasa del balanceo al gesto y vuelve sin tirones (caminando sin tocar: ~0,4 °/frame²).
      assert.ok(run.jerk < 2, `tirón de ${run.jerk.toFixed(1)} °/frame²`);
      const point = run.touches[0].point;
      const radial = point.clone().sub(column.position).setY(0).length();
      assert.ok(Math.abs(radial - 0.15) < 0.01, `toca a ${(radial * 100).toFixed(1)} cm del eje`);
    });
  }

  for (const speed of [0.8, 1.2, 1.5]) {
    it(`pared larga al lado (${speed} m/s): la toca una vez y desliza la mano por ella hasta que se acaba`, () => {
      const world = createWorld({ human: { config: { variation: 0 } } });
      const wall = addSurface(world, 'pared', 'right', 0.65, 5); // de 1 a 9 m
      const run = walkPast(world, speed, 9.5 / speed + 1, undefined, wall);
      assert.equal(run.touches.length, 1, `${run.touches.length} toques`);
      assert.deepEqual(run.phases, ['reach', 'contact', 'release', 'none']);
      // Apoyada casi toda la pared (empieza a tocarla hacia 1,5 m), pegada a ella, y la suelta al acabarse.
      assert.ok(run.contactDistance > 6.5, `apoyada ${run.contactDistance.toFixed(2)} m`);
      assert.ok(run.palmGap < 0.003, `la palma se separa ${(run.palmGap * 1000).toFixed(1)} mm`);
      assert.ok(run.jerk < 2.5, `tirón de ${run.jerk.toFixed(1)} °/frame²`);
    });
  }

  it('sin deslizar (touchSlide = false): toca la pared, la mano queda quieta y suelta al pasar', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    addSurface(world, 'pared', 'right', 0.65, 5);
    world.human.touchSlide = false;
    const run = walkPast(world, 1.2, 7);
    assert.equal(run.touches.length, 1, `${run.touches.length} toques`);
    assert.ok(run.contactDistance < 0.5, `apoyada ${run.contactDistance.toFixed(2)} m`);
    assert.ok(run.drift < 0.001 && run.jerk < 2, `mano ${(run.drift * 1000).toFixed(1)} mm, tirón ${run.jerk.toFixed(1)} °/frame²`);
  });

  it('baranda: apoya la palma encima (hacia abajo) y la desliza por ella', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    const railing = addSurface(world, 'baranda', 'left', 0.45, 5);
    const run = walkPast(world, 1.2, 7, () => UP, railing);
    assert.equal(run.touches.length, 1, `${run.touches.length} toques`);
    assert.ok(Math.abs(run.touches[0].point.y - 1.03) < 0.01, `toca a ${run.touches[0].point.y.toFixed(3)} m de altura`);
    assert.ok(run.palmFacing < -0.85, `palma · arriba ${run.palmFacing.toFixed(2)}`);
    assert.ok(run.contactDistance > 5, `apoyada ${run.contactDistance.toFixed(2)} m`);
    assert.ok(run.palmGap < 0.003, `la palma se separa ${(run.palmGap * 1000).toFixed(1)} mm`);
    assert.ok(run.jerk < 2.5, `tirón de ${run.jerk.toFixed(1)} °/frame²`);
  });

  it('no toca lo que no alcanza, corriendo, ni con autoTouch apagado', () => {
    const far = createWorld({ human: { config: { variation: 0 } } });
    addSurface(far, 'columna', 'right', 1.2, 3);
    assert.equal(walkPast(far, 1.2).touches.length, 0, 'columna a 1,2 m');

    const running = createWorld({ human: { config: { variation: 0 } } });
    addSurface(running, 'pared', 'right', 0.65, 8);
    assert.equal(walkPast(running, 3.5, 4).touches.length, 0, 'corriendo');

    const off = createWorld({ human: { config: { variation: 0 } } });
    addSurface(off, 'columna', 'right', 0.6, 3);
    off.human.autoTouch = false;
    assert.equal(walkPast(off, 1.2).touches.length, 0, 'autoTouch = false');
  });

  it('a otra escala (×0,6, con velocidades escaladas) es una copia exacta a escala', () => {
    const wrist = (s: number): number[][] => {
      const k = (x: number) => x * s;
      const world = createWorld({
        modelScale: s,
        terrainScale: s,
        human: {
          speedScale: 'off',
          config: {
            variation: 0,
            ...Object.fromEntries([...SPEED_PARAMS, ...ACCELERATION_PARAMS].map((p) => [p, k(defaultConfig[p])])),
            ...Object.fromEntries(PER_ACCELERATION_PARAMS.map((p) => [p, defaultConfig[p] / s])),
          },
        },
      });
      addSurface(world, 'pared', 'right', 0.65, 5, s);
      const frames: number[][] = [];
      simulate(world, 6, [[0, (h) => { h.targetSpeed = k(1.2); }]], {
        onFrame: () => frames.push(world.human.rig.rightArm!.hand.getWorldPosition(new Vector3()).divideScalar(s).toArray()),
      });
      return frames;
    };
    const a = wrist(1);
    const b = wrist(0.6);
    let max = 0;
    a.forEach((f, i) => f.forEach((x, j) => { max = Math.max(max, Math.abs(x - b[i][j])); }));
    assert.ok(max < 1e-4, `diferencia ${(max * 1000).toFixed(2)} mm`);
  });
});

describe('tocar a mano (touch)', () => {
  it('parado: toca un punto de la pared, lo suelta solo; con hold, espera a releaseTouch', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    const { human } = world;
    const wall = addSurface(world, 'pared', 'right', 0.55, 0);
    human.autoTouch = false;
    simulate(world, 0.5);
    const forward = human.locomotion.body.state.forward.clone();
    const out = new Vector3().crossVectors(forward, UP);
    // Cara de la pared hacia el personaje, a la altura del pecho y algo por delante.
    const point = human.position.clone().addScaledVector(out, 0.45).addScaledVector(forward, 0.15).setY(1.25);
    const faraway = point.clone().addScaledVector(out, 1);
    assert.equal(human.touch(faraway), false, 'no llega a 1,45 m');
    assert.equal(human.touch(point), true);
    simulate(world, 2, [], { start: 0.5 });
    assert.equal(human.touchPhase('right'), 'none', 'sin hold, la suelta');

    let touched = 0;
    human.on('touch', () => touched++);
    assert.equal(human.touch(point, { hold: true }), true);
    simulate(world, 2, [], { start: 2.5 });
    assert.equal(human.touchPhase('right'), 'contact', 'con hold, sigue apoyada');
    assert.equal(touched, 1);
    // La normal la busca en la pared: la palma mira hacia ella.
    const normal = new Vector3(1, 0, 0).applyQuaternion(wall.quaternion);
    assert.ok(Math.abs(palmNormal(human, 'right').dot(normal)) > 0.85, 'palma contra la pared');
    human.releaseTouch();
    simulate(world, 1, [], { start: 4.5 });
    assert.equal(human.touchPhase('right'), 'none');
  });
});
