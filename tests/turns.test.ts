import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { defaultConfig, type LocomotionConfig } from '../src/index.ts';
import type { Landmarks, LandmarkSeries } from './helpers/gaitAnalysis.ts';
import { humanLandmarks } from './helpers/humanLandmarks.ts';
import { angleDiff, createWorld, DEG, horizontalDistance, type Recorder, simulate, type World } from './helpers/sim.ts';
import { analyzeTurns } from './helpers/turnAnalysis.ts';

const UP = new Vector3(0, 1, 0);

interface TurnResult {
  r: Recorder;
  world: World;
  /** Velocidad mínima mientras gira (m/s). */
  minSpeed: number;
  /** Segundos hasta quedar a menos de 2° del rumbo pedido. */
  aligned: number;
  /** Pasos por segundo más alto entre dos pasos seguidos durante el giro. */
  maxCadence: number;
  /** Torsión máxima de la pierna (rad): giro del cuerpo respecto a un pie apoyado, en todo el giro. */
  twist: number;
  /** Lo máximo que se desplaza en un frame la punta de un pie apoyado plano (m): al pivotar, queda fija. */
  toeSlide: number;
}

/** Camina a `speed` y pide girar `angle` grados con el rumbo (como un mando o el teclado). */
function turnWhileWalking(angle: number, speed = 1, config: Partial<LocomotionConfig> = {}): TurnResult {
  const world = createWorld({ human: { config: { variation: 0, ...config } } });
  const { human } = world;
  const loco = human.locomotion;
  simulate(world, 3, [[0, (h) => { h.targetSpeed = speed; }]]);

  // Torsión medida en el esqueleto: rumbo tobillo → punta de cada pie respecto al del cuerpo,
  // menos el que tiene caminando recto (en reposo los pies no apuntan exactamente hacia delante).
  const toePosition = (side: 'left' | 'right', out: Vector3): Vector3 => human.rig[side].toe!.getWorldPosition(out);
  const yawOf = (v: Vector3): number => Math.atan2(v.x, v.z);
  const footYaw = (side: 'left' | 'right'): number =>
    yawOf(toePosition(side, new Vector3()).sub(human.rig[side].foot.getWorldPosition(new Vector3())));
  const legTwist = (side: 'left' | 'right'): number => angleDiff(yawOf(loco.body.state.forward), footYaw(side));
  const straight = { left: legTwist('left'), right: legTwist('right') };
  const lastToe = { left: new Vector3(), right: new Vector3() };
  let toeSlide = 0;

  let now = 0;
  let aligned = -1;
  let minSpeed = Infinity;
  let twist = 0;
  const steps: number[] = [];
  human.on('footstep', () => { if (aligned < 0) steps.push(now); });
  const r = simulate(world, 6, [[3, (h) => { h.targetHeading = h.heading + angle * DEG; }]], {
    start: 3,
    onFrame: (t) => {
      now = t;
      if (aligned >= 0) return;
      minSpeed = Math.min(minSpeed, human.speed);
      for (const side of ['left', 'right'] as const) {
        const phase = loco.feet[side].phase;
        if (phase !== 'SWING') twist = Math.max(twist, Math.abs(angleDiff(legTwist(side), straight[side])));
        const toe = toePosition(side, new Vector3());
        if (phase === 'PLANTED' && loco.feet[side].phase === phase && lastToe[side].lengthSq() > 0) {
          toeSlide = Math.max(toeSlide, Math.hypot(toe.x - lastToe[side].x, toe.z - lastToe[side].z));
        }
        if (phase === 'PLANTED') lastToe[side].copy(toe);
        else lastToe[side].set(0, 0, 0);
      }
      if (t > 3.05 && Math.abs(angleDiff(human.heading, human.targetHeading)) < 2 * DEG) aligned = t - 3;
    },
  });
  const intervals = steps.slice(1).map((s, i) => s - steps[i]);
  return { r, world, minSpeed, aligned, maxCadence: intervals.length ? 1 / Math.min(...intervals) : 0, twist, toeSlide };
}

describe('cambios de dirección caminando', () => {
  const results = new Map<number, TurnResult>();
  const turn = (angle: number): TurnResult => {
    if (!results.has(angle)) results.set(angle, turnWhileWalking(angle));
    return results.get(angle)!;
  };

  it('cuanto mayor el giro pendiente, más frena: 15° casi nada, 180° hasta ~0,55 × velocidad (intención de dirección)', () => {
    const speeds = [15, 45, 90, 180].map((a) => turn(a).minSpeed);
    assert.ok(speeds[0] > 0.99 && speeds[1] > 0.95, `15°: ${speeds[0].toFixed(2)}, 45°: ${speeds[1].toFixed(2)} m/s`);
    assert.ok(speeds[2] < speeds[1] - 0.05 && speeds[2] > 0.75, `90°: ${speeds[2].toFixed(2)} m/s`);
    const slowest = 1 - defaultConfig.turnSlowdown;
    assert.ok(speeds[3] < speeds[2] - 0.15 && Math.abs(speeds[3] - slowest) < 0.06, `180°: ${speeds[3].toFixed(2)} m/s`);
  });

  it('180°: sigue caminando y da la vuelta en curva, sin pararse a girar en el sitio (regresión)', () => {
    const { r, world, minSpeed, aligned } = turn(180);
    assert.ok(minSpeed > 0.4, `bajó a ${minSpeed.toFixed(2)} m/s`);
    assert.ok(aligned > 2.5 && aligned < 3.6, `alineado en ${aligned.toFixed(2)} s`);
    assert.ok(Math.abs(world.human.speed - 1) < 0.05, `al terminar va a ${world.human.speed.toFixed(2)} m/s`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
  });

  it('girando no acelera el ritmo de los pasos: pasos normales, no muchos pasos cortos (regresión: 3 pasos/s)', () => {
    for (const angle of [45, 90, 180]) {
      const { maxCadence } = turn(angle);
      assert.ok(maxCadence < defaultConfig.stepFrequency * 1.1, `${angle}°: ${maxCadence.toFixed(2)} pasos/s`);
    }
  });

  it('los pies acompañan al giro: aterrizan orientados hacia donde va el cuerpo y la pierna apenas se tuerce', () => {
    // Cada pie aterriza mirando hacia el rumbo de mitad de su apoyo (la pierna se tuerce la mitad en
    // cada sentido, ≈ ±18°), y el que ya estaba apoyado al empezar el giro pivota sobre la punta
    // (antes la pierna llegaba a ≈ 35°).
    for (const angle of [45, 90, 180]) {
      const { twist } = turn(angle);
      assert.ok(twist < 23 * DEG, `${angle}°: torsión ${(twist / DEG).toFixed(1)}°`);
    }
  });

  it('al pivotar, la punta del pie apoyado no se desliza y el pie se mueve sin tirones', () => {
    for (const angle of [90, 180]) {
      const { toeSlide, r } = turn(angle);
      assert.ok(toeSlide < 0.001, `${angle}°: la punta se movió ${(toeSlide * 1000).toFixed(2)} mm en un frame`);
      assert.ok(r.footJerk < 0.025, `${angle}°: tirón de un pie ${(r.footJerk * 1000).toFixed(1)} mm/frame²`);
    }
  });

  it('turnSlowdown = 0: gira sin frenar', () => {
    const { minSpeed } = turnWhileWalking(180, 1, { turnSlowdown: 0 });
    assert.ok(minSpeed > 0.999, `${minSpeed.toFixed(3)} m/s`);
  });
});

describe('point and click hacia un destino de lado o detrás', () => {
  /** Camina recto a 1 m/s y hace clic en un punto a `angle` grados y `distance` m. */
  function clickWhileWalking(angle: number, distance: number) {
    const world = createWorld({ human: { config: { variation: 0 } } });
    const { human } = world;
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 1; }]]);
    const forward = human.locomotion.body.state.forward.clone();
    const target = human.position.clone().addScaledVector(forward.applyAxisAngle(UP, angle * DEG), distance);
    let arrived = -1;
    let minSpeed = Infinity;
    let now = 0;
    human.on('arrive', () => { if (arrived < 0) arrived = now - 3; });
    const frames: Landmarks[] = [];
    // Cuánto se mueve cada pie en cada paso mientras gira (si apenas se mueve, los pasos se pisan) y
    // distancia mínima entre las rodillas.
    const lastLanding: Partial<Record<'left' | 'right', Vector3>> = {};
    let shortestTurnStep = Infinity;
    human.on('footstep', ({ side, position }) => {
      const before = lastLanding[side];
      const turning = Math.abs(angleDiff(human.locomotion.body.targetHeading, human.heading)) > 20 * DEG;
      if (before && now > 3 && turning) shortestTurnStep = Math.min(shortestTurnStep, horizontalDistance(before, position));
      lastLanding[side] = position.clone();
    });
    let knees = Infinity;
    const r = simulate(world, 9, [[3, (h) => h.moveTo(target)]], {
      start: 3,
      onFrame: (t) => {
        now = t;
        frames.push(humanLandmarks(human));
        const last = frames[frames.length - 1];
        knees = Math.min(knees, horizontalDistance(last.knee.left, last.knee.right));
        // Hasta acercarse al destino (luego frena para detenerse en él).
        if (horizontalDistance(human.position, target) > 0.7 && arrived < 0) minSpeed = Math.min(minSpeed, human.speed);
      },
    });
    // Puntos del cuerpo para el análisis de la vuelta (el reposo no se usa en él).
    const series: LandmarkSeries = { dt: 1 / 60, legLength: human.legLength, rest: frames[0], frames };
    return { r, world, target, arrived, minSpeed, series, knees, shortestTurnStep, error: horizontalDistance(human.position, target) };
  }

  it('90° a 4 m: gira caminando (≥ 0.75 m/s) y llega', () => {
    const { r, world, arrived, minSpeed, error } = clickWhileWalking(90, 4);
    assert.ok(minSpeed > 0.75, `bajó a ${minSpeed.toFixed(2)} m/s`);
    assert.ok(arrived > 0 && error < 0.1, `llegada ${arrived.toFixed(2)} s, a ${(error * 100).toFixed(1)} cm`);
    assert.equal(world.human.gaitMode, 'idle');
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
  });

  // Más de 120°: frena y gira en 2–3 pasos grandes que ya se desplazan hacia la nueva dirección, como en
  // las vueltas de CMU (2–3 pasos de ~100–140°, sin pararse del todo: 0,3–0,5 m/s). Antes: 4 pasitos casi
  // en el sitio que se pisaban; antes aún, una U de 1–3 m de ancho.
  for (const [angle, distance] of [[135, 3], [180, 3]]) {
    it(`${angle}° a ${distance} m: frena y gira en 2–3 pasos grandes, sin pisarse, y llega`, () => {
      const { r, world, arrived, error, series, knees, shortestTurnStep } = clickWhileWalking(angle, distance);
      const turns = analyzeTurns(series, 100);
      assert.equal(turns.length, 1, `${turns.length} vueltas`);
      const turn = turns[0];
      assert.ok(turn.steps <= 3 && turn.stepTurn > 80, `${turn.steps} pasos de ${turn.stepTurn.toFixed(0)}°`);
      assert.ok(shortestTurnStep > 0.25, `girando, un pie solo se movió ${(shortestTurnStep * 100).toFixed(0)} cm`);
      assert.ok(knees > 0.1, `rodillas a ${(knees * 100).toFixed(0)} cm`);
      assert.ok(turn.duration < 1.5, `giro en ${turn.duration.toFixed(2)} s`);
      assert.ok(turn.lateral < 0.6, `se aparta ${(turn.lateral * 100).toFixed(0)} cm de la línea`);
      assert.ok(arrived > 0 && error < 0.1, `llegada ${arrived.toFixed(2)} s, a ${(error * 100).toFixed(1)} cm`);
      assert.equal(world.human.gaitMode, 'idle');
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
    });
  }

  it('caminando deprisa, el paso que ya estaba en el aire al recibir la vuelta se acorta (frena)', () => {
    // En CMU el primer paso de la vuelta mide 0,68–0,95 veces la zancada de llegada. Antes era una zancada
    // entera: el aterrizaje se decidía al despegar, sin saber que iba a frenar.
    const world = createWorld({ human: { config: { variation: 0 } } });
    const { human } = world;
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 1.4; }]]);
    const last = { left: human.locomotion.feet.left.planted.clone(), right: human.locomotion.feet.right.planted.clone() };
    const before = { left: 0, right: 0 };
    const lengths: number[] = [];
    human.on('footstep', ({ side, position }) => {
      lengths.push(horizontalDistance(position, last[side]));
      last[side] = position.clone();
    });
    // La zancada normal de cada pie, justo antes (los dos últimos pasos a 1,4 m/s).
    simulate(world, 1.4, [], { start: 3 });
    before.left = lengths.at(-2)!;
    before.right = lengths.at(-1)!;
    // La orden, recién despegado un pie (el caso en que antes aterrizaba con la zancada entera).
    let t = 4.4;
    const feet = human.locomotion.feet;
    const justLifted = () => (['left', 'right'] as const).some((s) => feet[s].phase === 'SWING' && feet[s].swing.t < 0.15);
    while (!justLifted()) simulate(world, 1 / 60, [], { start: t, dt: 1 / 60, onFrame: (now) => { t = now; } });
    lengths.length = 0;
    simulate(world, 1, [[t, (h) => h.moveTo(h.position.clone().add(h.locomotion.body.state.forward.clone().multiplyScalar(-4)))]], { start: t });
    const stride = Math.max(before.left, before.right);
    assert.ok(lengths[0] < 0.88 * stride, `primer paso ${(lengths[0] * 100).toFixed(0)} cm, zancada ${(stride * 100).toFixed(0)} cm`);
  });

  it('al salir de la vuelta acelera en 2–3 pasos: ningún paso largo con la pierna de atrás estirada', () => {
    // Desde parado, destino 4 m detrás. Antes, al terminar la vuelta pasaba de golpe a la velocidad de
    // crucero: el pie que había pivotado se quedaba atrás (0,7 piernas) y el paso siguiente medía 1,88
    // piernas (caminando normal, 1,58–1,68).
    const world = createWorld({ human: { config: { variation: 0 } } });
    const { human } = world;
    const last = { left: human.locomotion.feet.left.planted.clone(), right: human.locomotion.feet.right.planted.clone() };
    let longest = 0;
    human.on('footstep', ({ side, position }) => {
      longest = Math.max(longest, horizontalDistance(position, last[side]) / human.legLength);
      last[side] = position.clone();
    });
    simulate(world, 5, [[0.5, (h) => h.moveTo(new Vector3(0, 0, 4))]]);
    assert.ok(longest < 1.75, `paso más largo ${longest.toFixed(2)} × pierna`);
  });

  it('al dar la vuelta, el pie en el aire no se va lejos de la cadera (la pierna no se estira de lado)', () => {
    // Para rodear el pie apoyado, el swing se desvía hacia su lado. Si la línea recta pasaba cerca de él
    // justo al despegar o al aterrizar, el desvío (que entra con sen²(π·t)) se amplificaba hasta 1,35
    // piernas y el tobillo quedaba a 1,29 piernas de la cadera: la pierna estirada hacia fuera. Caminando
    // normal no pasa de ~0,5.
    let worst = { reach: 0, label: '' };
    for (const walking of [true, false]) {
      for (const angle of [125, 140, 155, 170, -125, -140, -155, -170]) {
        const world = createWorld({ human: { config: { variation: 0 } } });
        const { human } = world;
        const loco = human.locomotion;
        const start = walking ? 3 : 0;
        if (walking) simulate(world, 3, [[0, (h) => { h.targetSpeed = 1.4; }]]);
        const forward = loco.body.state.forward.clone();
        const target = human.position.clone().addScaledVector(forward.applyAxisAngle(UP, angle * DEG), 4);
        simulate(world, 3, [[start, (h) => h.moveTo(target)]], {
          start,
          onFrame: () => {
            for (const side of ['left', 'right'] as const) {
              if (loco.feet[side].phase !== 'SWING') continue;
              const hip = human.rig[side].thigh.getWorldPosition(new Vector3());
              const reach = horizontalDistance(hip, loco.feet[side].position) / human.legLength;
              if (reach > worst.reach) worst = { reach, label: `${walking ? 'caminando' : 'parada'}, ${angle}°, pie ${side}` };
            }
          },
        });
      }
    }
    assert.ok(worst.reach < 0.7, `tobillo a ${worst.reach.toFixed(2)} piernas de la cadera (${worst.label})`);
  });

  it('destino muy cerca y detrás (1,2 m): pivota, no lo rodea, llega', () => {
    const { r, arrived, error } = clickWhileWalking(180, 1.2);
    assert.ok(arrived > 0 && arrived < 5, `llegada ${arrived.toFixed(2)} s`);
    assert.ok(error < 0.1, `a ${(error * 100).toFixed(1)} cm`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, r.liftoffs);
  });
});
