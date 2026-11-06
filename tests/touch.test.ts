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

  it('caminando de un punto a otro junto a la misma pared (parando entre medio), la toca cada vez', () => {
    // Antes solo la tocaba la primera vez: el objeto ya tocado no se repite mientras siga a la vista, y caminando
    // junto a ella no la perdía de vista. Pararse y volver a andar es otra pasada.
    const world = createWorld();
    addSurface(world, 'pared', 'right', 0.65, 3);
    let touches = 0;
    world.human.on('touch', () => touches++);
    simulate(world, 12, [[0, (h) => h.moveTo(new Vector3(0, 0, -1.5))], [4, (h) => h.moveTo(new Vector3(0, 0, -3))], [8, (h) => h.moveTo(new Vector3(0, 0, -4.5))]]);
    assert.equal(touches, 3);
  });

  it('sin deslizar (touchSlide = false): toca la pared, la mano queda quieta y suelta al pasar', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    addSurface(world, 'pared', 'right', 0.65, 5);
    world.human.touchSlide = false;
    const run = walkPast(world, 1.2, 7);
    assert.equal(run.touches.length, 1, `${run.touches.length} toques`);
    assert.ok(run.contactDistance < 0.5, `apoyada ${run.contactDistance.toFixed(2)} m`);
    assert.ok(run.drift < 0.001 && run.jerk < 2, `mano ${(run.drift * 1000).toFixed(1)} mm, tirón ${run.jerk.toFixed(1)} °/frame²`);
  });

  it('pared con una pilastra: desliza la mano hasta poco antes, la suelta sin pasar por encima y la vuelve a apoyar después', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    const { human } = world;
    const start = human.position.clone();
    const forward = human.locomotion.body.state.forward.clone();
    const wall = addSurface(world, 'pared', 'right', 0.65, 5); // de 1 a 9 m, la cara a 0,55 m
    // Pilastra que sobresale 4 cm de la pared, de 4,85 a 5,15 m.
    const pilaster = new Mesh(new BoxGeometry(0.28, 2.5, 0.3), new MeshBasicMaterial());
    pilaster.position.copy(wall.position);
    pilaster.quaternion.copy(wall.quaternion);
    world.scene.add(pilaster);
    pilaster.updateMatrixWorld(true);
    human.touchables = [wall, pilaster];
    const out = new Vector3().crossVectors(forward, UP);
    const hand = (human.locomotion.touch as unknown as { hands: Record<Side, { point: Vector3 }> }).hands.right;
    // Cada apoyo: hasta dónde llega la mano (m hacia delante) y cuánto cambia su distancia al camino (m).
    const contacts: { reach: number; minLateral: number; maxLateral: number }[] = [];
    let wasContact = false;
    simulate(world, 9, [[0, (h) => { h.targetSpeed = 1.2; }]], {
      onFrame: () => {
        const contact = human.touchPhase('right') === 'contact';
        if (contact) {
          const offset = hand.point.clone().sub(start);
          const lateral = offset.dot(out);
          if (!wasContact) contacts.push({ reach: -Infinity, minLateral: lateral, maxLateral: lateral });
          const c = contacts.at(-1)!;
          c.reach = Math.max(c.reach, offset.dot(forward));
          c.minLateral = Math.min(c.minLateral, lateral);
          c.maxLateral = Math.max(c.maxLateral, lateral);
        }
        wasContact = contact;
      },
    });
    assert.ok(contacts.length > 0, 'no la toca');
    // El primer apoyo, en la pared: la suelta antes de que la mano llegue a la pilastra.
    assert.ok(contacts[0].reach < 4.8, `la mano llega a ${contacts[0].reach.toFixed(2)} m (la pilastra empieza a 4,85 m)`);
    // Ningún apoyo pasa de la pared a la pilastra o al revés (la mano iría por encima del saliente).
    for (const c of contacts) {
      assert.ok(c.maxLateral - c.minLateral < 0.01, `apoyada, la mano cambia ${((c.maxLateral - c.minLateral) * 100).toFixed(1)} cm de profundidad`);
    }
    // Pasada la pilastra, la vuelve a apoyar en la pared (la cara, a 0,55 m; la de la pilastra, a 0,51 m).
    assert.ok(
      contacts.some((c) => c.reach > 5.5 && c.minLateral > 0.53),
      `apoyos: ${contacts.map((c) => `${c.reach.toFixed(2)} m a ${c.minLateral.toFixed(2)} m`).join(', ')}`,
    );
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

  // Al pie o, con el gesto activado a los 2,5 s, a mitad de la subida (la mano estaba ocupada): ahí el hombro
  // sube mientras la mano va a la baranda, y la baranda en pendiente no es la vertical de la palma.
  for (const [from, label, minimum] of [[0, 'al empezar a subir', 1.5], [2.5, 'a mitad de la subida', 1]] as const) {
    it(`escalera con baranda (postes y pilar al arranque): la apoya ${label} y la desliza hasta arriba`, () => {
      // Escalera de 17 × 28 cm hacia −Z (donde mira el personaje) y rellano; a la derecha, la baranda a 1 m sobre
      // los bordes de los escalones, con pasamanos intermedio, tres postes y un pilar al pie.
      const rise = 0.17, stairRun = 0.28, count = 8, start = 1.5;
      const world = createWorld({
        human: { config: { variation: 0 } },
        buildTerrain: (terrain) => {
          const block = (height: number, z0: number, z1: number): void => {
            const mesh = new Mesh(new BoxGeometry(1.2, height, z0 - z1), new MeshBasicMaterial());
            mesh.position.set(0, height / 2, (z0 + z1) / 2);
            terrain.add(mesh);
          };
          for (let i = 0; i < count - 1; i++) block(rise * (i + 1), -start - stairRun * i, -start - stairRun * (i + 1));
          block(rise * count, -start - stairRun * (count - 1), -start - stairRun * (count - 1) - 8);
          terrain.updateMatrixWorld(true);
        },
      });
      const { human } = world;
      const x = 0.45;
      const z0 = -start, z1 = -start - stairRun * (count - 1);
      const y0 = rise, y1 = rise * count;
      const length = Math.hypot(z1 - z0, y1 - y0);
      const parts: Mesh[] = [];
      const add = (geometry: BoxGeometry, px: number, py: number, pz: number, tilt = 0): Mesh => {
        const mesh = new Mesh(geometry, new MeshBasicMaterial());
        mesh.position.set(px, py, pz);
        mesh.rotation.x = tilt;
        world.scene.add(mesh);
        mesh.updateMatrixWorld(true);
        parts.push(mesh);
        return mesh;
      };
      const tilt = Math.atan2(y1 - y0, z0 - z1); // sube hacia −Z
      const rail = add(new BoxGeometry(0.05, 0.05, length), x, (y0 + y1) / 2 + 1, (z0 + z1) / 2, tilt);
      add(new BoxGeometry(0.05, 0.025, length), x, (y0 + y1) / 2 + 0.5, (z0 + z1) / 2, tilt);
      for (const t of [0, 0.5, 1]) add(new BoxGeometry(0.04, 1 + rise, 0.04), x, y0 + (y1 - y0) * t - rise + (1 + rise) / 2, z0 + (z1 - z0) * t);
      add(new BoxGeometry(0.18, 1.1, 0.18), x + 0.05, 0.55, z0 + 0.15);
      human.touchables = parts;
      const hand = (human.locomotion.touch as unknown as { hands: Record<Side, { object: unknown }> }).hands.right;
      let onRail = 0;
      let contactStart: Vector3 | null = null;
      const touched: unknown[] = [];
      human.on('touch', () => touched.push(hand.object));
      human.autoTouch = from === 0;
      simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }], [from, (h) => { h.autoTouch = true; }]], {
        onFrame: () => {
          const resting = human.touchPhase('right') === 'contact' && hand.object === rail;
          if (resting) {
            contactStart ??= human.position.clone();
            onRail = Math.max(onRail, horizontalDistance(human.position, contactStart));
          } else contactStart = null;
        },
      });
      // Solo la baranda (ni la cabeza del pilar, ni el costado del pasamanos, ni un poste), y hasta arriba (el tramo
      // mide 1,96 m en horizontal).
      assert.ok(touched.length > 0 && touched.every((o) => o === rail), `toca ${touched.map((o) => (o === rail ? 'baranda' : 'otra cosa')).join(', ')}`);
      assert.ok(onRail > minimum, `apoyada en la baranda ${onRail.toFixed(2)} m`);
    });
  }

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

/**
 * Da dos vueltas con followPath alrededor de una superficie cilíndrica de radio `radius` (a `walk` m de su eje,
 * en el sentido `turn`, ±1), con touchCurveRadius `curve`, y mide el toque mientras la rodea.
 */
function walkAround(radius: number, walk: number, turn: number, curve: number) {
  const world = createWorld();
  const { human } = world;
  const surface = new Mesh(new CylinderGeometry(radius, radius, 3, 48), new MeshBasicMaterial());
  surface.position.set(0, 1.5, -3);
  world.scene.add(surface);
  surface.updateMatrixWorld(true);
  human.touchables = [surface];
  human.setConfig({ touchCurveRadius: curve });
  const points: Vector3[] = [];
  for (let k = 0; k <= 64; k++) {
    const a = Math.PI / 2 + turn * (k / 32) * 2 * Math.PI;
    points.push(new Vector3(Math.cos(a) * walk, 0, -3 + Math.sin(a) * walk));
  }
  const hands = (human.locomotion.touch as unknown as { hands: Record<Side, { point: Vector3 }> }).hands;
  const ray = new Raycaster();
  const result = { touches: 0, contact: 0, jerk: 0, palmGap: 0, palmFacing: -1, handPath: 0, bodyPath: 0, rootRadius: 0 };
  human.on('touch', () => result.touches++);
  const previous: Record<Side, { q: Quaternion[]; w: number[] }> = { left: { q: [], w: [] }, right: { q: [], w: [] } };
  let circling = 0;
  let lastHand: Vector3 | null = null;
  let lastBody: Vector3 | null = null;
  simulate(world, 20, [[0, (h) => h.followPath(points)]], {
    onFrame: (t) => {
      const fromAxis = Math.hypot(human.position.x, human.position.z + 3);
      // Rodeándola: en el círculo, todavía con destino, y pasado el acercamiento.
      const around = human.moveTarget !== null && fromAxis < walk + 0.1 && t > 4;
      if (around) {
        circling++;
        result.rootRadius += fromAxis;
      }
      for (const side of ['left', 'right'] as const) {
        const arm = human.rig[side === 'left' ? 'leftArm' : 'rightArm']!;
        const p = previous[side];
        const qs = [arm.upperArm, arm.forearm, arm.hand].map((b) => b.getWorldQuaternion(new Quaternion()));
        const w = qs.map((q, i) => (p.q[i] ? (2 * Math.acos(Math.min(1, Math.abs(q.dot(p.q[i]))))) / DEG : 0));
        if (p.w.length > 0 && t > 0.3) w.forEach((x, i) => { result.jerk = Math.max(result.jerk, Math.abs(x - p.w[i])); });
        previous[side] = { q: qs, w };
        if (human.touchPhase(side) !== 'contact') continue;
        const { center, normal } = palm(human, side);
        ray.set(center.clone().addScaledVector(normal, -0.2), normal);
        const hit = ray.intersectObject(surface)[0];
        result.palmGap = Math.max(result.palmGap, hit ? Math.abs(hit.distance - 0.2) : 1);
        result.palmFacing = Math.max(result.palmFacing, normal.dot(new Vector3(center.x, 0, center.z + 3).normalize()));
        if (!around) continue;
        result.contact++;
        if (lastHand) result.handPath += hands[side].point.distanceTo(lastHand);
        if (lastBody) result.bodyPath += human.position.distanceTo(lastBody);
        lastHand = hands[side].point.clone();
        lastBody = human.position.clone();
      }
    },
  });
  result.contact /= Math.max(circling, 1);
  result.rootRadius /= Math.max(circling, 1);
  return result;
}

describe('tocar superficies curvas al rodearlas (touchCurveRadius)', () => {
  // Un tronco de 10 cm, una columna de 30 cm y una pared curva de 1,5 m de radio, en los dos sentidos, con la
  // raíz a unos 55 cm de la superficie.
  for (const [radius, walk] of [[0.1, 0.7], [0.3, 0.9], [1.5, 2.05]] as const) {
    for (const turn of [1, -1]) {
      it(`radio ${radius} m, girando hacia ${turn > 0 ? 'un lado' : 'el otro'}: apoya la mano y la desliza con la superficie, sin tirones`, () => {
        const r = walkAround(radius, walk, turn, 0.05);
        assert.ok(r.contact > 0.75, `apoyada solo el ${(r.contact * 100).toFixed(0)} % de la vuelta`);
        assert.ok(r.palmGap < 0.01, `la palma se separó ${(r.palmGap * 100).toFixed(1)} cm`);
        assert.ok(r.palmFacing < -0.9, `la palma no mira la superficie (${r.palmFacing.toFixed(2)}, toques ${r.touches}, apoyada ${(r.contact * 100).toFixed(0)} %)`);
        assert.ok(r.jerk < 2.5, `tirón de ${r.jerk.toFixed(2)} °/frame²`);
        // Por dentro de la curva, la mano recorre menos que el cuerpo: lo que da el radio de la superficie entre el
        // de la raíz (el hombro de dentro va algo más cerca).
        const expected = radius / r.rootRadius;
        const ratio = r.handPath / r.bodyPath;
        assert.ok(Math.abs(ratio - expected) < 0.06, `la mano recorre ${ratio.toFixed(2)} lo que el cuerpo (radios: ${expected.toFixed(2)})`);
      });
    }
  }

  it('sin la opción (0, por defecto), una columna se toca y se suelta: rodeándola, la mano no se queda apoyada', () => {
    const r = walkAround(0.3, 0.9, 1, 0);
    assert.ok(r.contact < 0.1, `apoyada el ${(r.contact * 100).toFixed(0)} % de la vuelta`);
  });

  it('al acabar de rodear una pared curva, parado a su lado, no toca, suelta y vuelve a tocar sin parar', () => {
    // Un arco de ~150° a 55 cm de una pared de 2,5 m de radio, y luego parado a su lado 6 s.
    const world = createWorld();
    const { human } = world;
    const wall = new Mesh(new CylinderGeometry(2.5, 2.5, 3, 96), new MeshBasicMaterial());
    wall.position.set(0, 1.5, -3);
    world.scene.add(wall);
    wall.updateMatrixWorld(true);
    human.touchables = [wall];
    human.setConfig({ touchCurveRadius: 0.05 });
    const points: Vector3[] = [];
    for (let k = 0; k <= 24; k++) {
      const angle = Math.PI / 2 + (k / 24) * 2.6;
      points.push(new Vector3(Math.cos(angle) * 3.05, 0, -3 + Math.sin(angle) * 3.05));
    }
    let touches = 0;
    let stillTouches = 0;
    human.on('touch', () => {
      touches++;
      if (human.moveTarget === null) stillTouches++;
    });
    simulate(world, 18, [[0, (h) => h.followPath(points)]]);
    assert.ok(touches >= 1, 'no la tocó');
    assert.ok(stillTouches <= 1, `parado, la tocó ${stillTouches} veces`);
  });

  it('touchCurveRadius negativo es un error', () => {
    const world = createWorld();
    assert.throws(() => world.human.setConfig({ touchCurveRadius: -0.1 }), /touchCurveRadius/);
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
