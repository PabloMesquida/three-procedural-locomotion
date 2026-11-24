import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import { createGroundHit, defaultConfig, RaycastGroundDetector } from '../src/index.ts';
import { createWorld, DEG, SIDES, simulate, type World } from './helpers/sim.ts';

/** Caja de w × h × d con la base a `y`, centrada en (x, z). */
function block(parent: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, z);
  parent.add(mesh);
}

const HEIGHT = 2;
/** La cornisa va a lo largo de −Z, de x = WALL_X − width (el borde) a x = WALL_X (la pared, a la derecha). */
const WALL_X = 0.2;
const LEDGE_WIDTH = 0.35;

interface LedgeOptions {
  /** Ancho de la cornisa (m). */
  width?: number;
  /** Altura de la pared sobre la cornisa (m). */
  wall?: number;
  /** Sin caída al otro lado: suelo ancho a la altura de la cornisa (un pasillo junto a una pared). */
  noDrop?: boolean;
  /**
   * Una escalera desde cada plataforma hasta el suelo (por fuera: +Z la primera, −Z la segunda): se puede ir de una a
   * otra por abajo, rodeando la cornisa.
   */
  stairs?: boolean;
  /** Añade cosas al terreno (salientes en la pared…). */
  extra?: (terrain: Object3D) => void;
  /** Giro del personaje al crearlo (rad, como el heading: + a la izquierda; 0 = mirando hacia −Z). */
  turn?: number;
}

/**
 * Plataforma (z de 1,5 a −1), cornisa (z de −1 a −7) y otra plataforma (z de −7 a −10), a 2 m sobre el suelo, con una
 * pared a su derecha (x > WALL_X). El personaje, que mira hacia −Z, de pie en (x, z).
 */
function ledgeWorld(x = 0, z = 0, options: LedgeOptions = {}): World {
  const width = options.width ?? LEDGE_WIDTH;
  const world = createWorld({
    buildTerrain: (terrain) => {
      block(terrain, 1.7, HEIGHT, 2.5, WALL_X - 0.85, 0, 0.25);
      if (options.noDrop) block(terrain, 1.7, HEIGHT, 6, WALL_X - 0.85, 0, -4);
      else block(terrain, width, HEIGHT, 6, WALL_X - width / 2, 0, -4);
      block(terrain, 1.7, HEIGHT, 3, WALL_X - 0.85, 0, -8.5);
      block(terrain, 1, HEIGHT + (options.wall ?? 2.5), 11.5, WALL_X + 0.5, 0, -4.25);
      if (options.stairs) {
        const steps = 12;
        for (let k = 1; k < steps; k++) {
          const out = 0.28 * (steps - k - 0.5);
          block(terrain, 1, (HEIGHT * k) / steps, 0.28, -0.6, 0, 1.5 + out);
          block(terrain, 1, (HEIGHT * k) / steps, 0.28, -0.6, 0, -10 - out);
        }
      }
      options.extra?.(terrain);
    },
    place: (model, scene) => {
      model.rotateY(options.turn ?? 0);
      scene.add(model);
    },
  });
  world.model.position.set(x, HEIGHT, z);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

const ankle = (world: World, side: 'left' | 'right'): Vector3 => world.human.rig[side].foot.getWorldPosition(new Vector3());
const hips = (world: World): Vector3 => world.human.rig.hips.getWorldPosition(new Vector3());
/** Hacia dónde mira el cuerpo (yaw del mundo, rad, desde +Z). */
const facingYaw = (world: World): number => {
  const f = world.human.locomotion.body.state.forward;
  return Math.atan2(f.x, f.z);
};
const angleTo = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** De espaldas a la pared (que está en +X): mirando hacia −X. */
const AWAY_FROM_WALL = -Math.PI / 2;

/** Traza por consola (LEDGE_TRACE=1). */
function trace(world: World, t: number): void {
  if (!process.env.LEDGE_TRACE) return;
  const { human } = world;
  const s = human.locomotion.body.state;
  const l = ankle(world, 'left');
  const r = ankle(world, 'right');
  const h = hips(world);
  console.log(
    `t=${t.toFixed(2)} z=${s.position.z.toFixed(2)} x=${s.position.x.toFixed(3)} v=${s.speed.toFixed(2)} ledge=${human.ledge.toFixed(2)} off=${(s.facingOffset / DEG).toFixed(0)} ` +
      `L=(${l.x.toFixed(2)},${l.z.toFixed(2)}) R=(${r.x.toFixed(2)},${r.z.toFixed(2)}) hips=(${h.x.toFixed(3)},${h.y.toFixed(2)}) hb=${((human.locomotion as unknown as { ledgeHipBack: number }).ledgeHipBack * 100).toFixed(1)} lean=${((human.locomotion as unknown as { ledgeLean: number }).ledgeLean / DEG).toFixed(1)} ${human.gaitMode} ${human.footPhase('left')[0]}${human.footPhase('right')[0]}`,
  );
}

describe('cornisas', () => {
  it('a lo largo de una cornisa de 35 cm: de espaldas a la pared, de lado, despacio, sin cruzar los pies ni pisar fuera', () => {
    const world = ledgeWorld();
    const { human } = world;
    const loco = human.locomotion;
    let minLedge = 1;
    let maxSpeed = 0;
    let maxTurn = 0;
    let minHips = Infinity;
    let maxHips = -Infinity;
    let minApart = Infinity;
    let maxApart = 0;
    let minFoot = Infinity;
    let maxFoot = -Infinity;
    let afterLedge = 0;
    let afterTurn = 0;
    let next = 0;
    const r = simulate(world, 23, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: (t) => {
        if (t >= next) {
          trace(world, t);
          next += 0.25;
        }
        const z = human.position.z;
        if (z < -2 && z > -6) {
          minLedge = Math.min(minLedge, human.ledge);
          maxSpeed = Math.max(maxSpeed, human.speed);
          maxTurn = Math.max(maxTurn, angleTo(facingYaw(world), AWAY_FROM_WALL));
          const x = hips(world).x;
          minHips = Math.min(minHips, WALL_X - x);
          maxHips = Math.max(maxHips, WALL_X - x);
          // El pie de delante (el derecho, hacia −Z) va siempre delante: el otro se le acerca sin cruzarlo.
          const apart = ankle(world, 'left').z - ankle(world, 'right').z;
          minApart = Math.min(minApart, apart);
          if (human.footPhase('left') !== 'SWING' && human.footPhase('right') !== 'SWING') maxApart = Math.max(maxApart, apart);
          for (const side of SIDES) {
            if (human.footPhase(side) === 'SWING') continue;
            minFoot = Math.min(minFoot, WALL_X - loco.feet[side].planted.x);
            maxFoot = Math.max(maxFoot, WALL_X - loco.feet[side].planted.x);
          }
        }
        if (z < -8.5) {
          afterLedge = Math.max(afterLedge, human.ledge);
          afterTurn = Math.max(afterTurn, angleTo(facingYaw(world), Math.PI));
        }
      },
    });
    assert.ok(minLedge > 0.99, `ledge ${minLedge.toFixed(2)}`);
    assert.ok(maxSpeed <= defaultConfig.ledgeMaxSpeed + 1e-6, `velocidad ${maxSpeed.toFixed(2)} m/s`);
    assert.ok(maxTurn < 1 * DEG, `el cuerpo se giró ${(maxTurn / DEG).toFixed(1)}° de espaldas a la pared`);
    // La cadera, a lo que sobresalen los glúteos de la pared (14 % de su altura sin malla: ~13 cm).
    assert.ok(minHips > 0.11 && maxHips < 0.15, `cadera a ${(minHips * 100).toFixed(1)}–${(maxHips * 100).toFixed(1)} cm de la pared`);
    assert.ok(minApart > 0.1, `los tobillos se juntan hasta ${(minApart * 100).toFixed(1)} cm`);
    assert.ok(maxApart > 0.3 && maxApart < 0.5, `los pies se abren hasta ${(maxApart * 100).toFixed(1)} cm`);
    // Tobillo: el talón no toca la pared y la punta no pasa del borde.
    assert.ok(minFoot > 0.08 && maxFoot < LEDGE_WIDTH - 0.17, `tobillos a ${(minFoot * 100).toFixed(1)}–${(maxFoot * 100).toFixed(1)} cm de la pared`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, `slip ${r.slip}, IK ${r.stanceIK}, ${r.liftoffs}`);
    assert.ok(r.finiteOK);
    assert.ok(human.position.z < -9, `no llegó al final (z = ${human.position.z.toFixed(2)})`);
    assert.ok(afterLedge === 0 && afterTurn < 3 * DEG, `en la plataforma: ledge ${afterLedge}, girado ${(afterTurn / DEG).toFixed(1)}°`);
  });

  it('las palmas, apoyadas en la pared a cada lado de las caderas, con los dedos hacia abajo', () => {
    const world = ledgeWorld();
    const { human } = world;
    let frames = 0;
    let worst = 0;
    let minWeight = 1;
    let fingersUp = -Infinity;
    simulate(world, 9, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: () => {
        // Ya asentado: al entrar frena y, ya despacio, se pone de espaldas; la espalda (y con ella las manos) aún se
        // acerca a la pared.
        if (human.ledge < 0.999 || ++frames < 120) return;
        for (const side of SIDES) {
          const arm = side === 'left' ? human.rig.leftArm! : human.rig.rightArm!;
          const wrist = arm.hand.getWorldPosition(new Vector3());
          const knuckle = (arm.fingers?.middle?.[0] ?? arm.hand).getWorldPosition(new Vector3());
          // Muñeca y nudillos, a lo sumo a 3 cm de la pared (el grosor de la mano): la palma, plana sobre ella.
          worst = Math.max(worst, WALL_X - wrist.x, WALL_X - knuckle.x);
          minWeight = Math.min(minWeight, human.locomotion.touch.weight(side));
          fingersUp = Math.max(fingersUp, knuckle.y - wrist.y);
        }
      },
    });
    assert.ok(frames > 180, `en la cornisa ${frames} frames`);
    assert.ok(minWeight > 0.999, `apoyo ${minWeight.toFixed(3)}`);
    assert.ok(worst < 0.03, `mano a ${(worst * 100).toFixed(1)} cm de la pared`);
    assert.ok(fingersUp < 0, `dedos hacia arriba (${(fingersUp * 100).toFixed(1)} cm)`);
  });

  it('contra una pared irregular, la espalda sigue en ella y el cuerpo no gira', () => {
    // Salientes de 4 a 8 cm en la pared, a distintas alturas, de 40 cm a lo largo.
    const bumps: [y: number, h: number, depth: number, z: number][] = [
      [0.7, 0.4, 0.06, -2.4], [1.2, 0.5, 0.08, -3.3], [0.3, 1.5, 0.04, -4.2], [0.9, 0.3, 0.05, -5.0],
    ];
    const world = ledgeWorld(0, 0, {
      extra: (terrain) => {
        for (const [y, h, d, z] of bumps) block(terrain, d + 0.01, h, 0.4, WALL_X - d / 2 + 0.005, HEIGHT + y, z);
      },
    });
    const { human } = world;
    const detector = new RaycastGroundDetector([world.terrain]);
    const hit = createGroundHit();
    /** Lo que más sobresale la pared entre `bottom` y `top` (sobre la cornisa) en `z` (m, x del mundo). */
    const wallAt = (z: number, bottom: number, top: number): number => {
      for (let x = WALL_X - 0.1; x <= WALL_X; x += 0.002) {
        if (detector.castDown(new Vector3(x, HEIGHT + top, z), top - bottom, hit) && hit.point.y >= HEIGHT + bottom) return x;
      }
      return WALL_X;
    };
    let maxTurn = 0;
    let minGap = Infinity;
    let sumGap = 0;
    let count = 0;
    let settled = 0;
    let next = 0;
    simulate(world, 21, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: (t) => {
        if (t >= next) {
          trace(world, t);
          next += 0.25;
        }
        const z = human.position.z;
        if (z > -2 || z < -6) return;
        maxTurn = Math.max(maxTurn, angleTo(facingYaw(world), AWAY_FROM_WALL));
        // Ya asentado, un segundo en la cornisa: al entrar frena y, ya despacio, se pone de espaldas, y la espalda aún se
        // acerca a la pared.
        if (human.ledge < 0.999 || ++settled < 60) return;
        // La cadera, a lo que sobresalen los glúteos de lo que más sobresale la pared a su altura, a lo ancho de la espalda.
        const h = hips(world);
        let wall = -Infinity;
        for (let dz = -0.14; dz <= 0.141; dz += 0.02) wall = Math.max(wall, wallAt(h.z + dz, 0.7, 1.0));
        const gap = wall - h.x;
        minGap = Math.min(minGap, gap);
        sumGap += gap;
        count++;
      },
    });
    assert.ok(maxTurn < 1 * DEG, `el cuerpo se giró ${(maxTurn / DEG).toFixed(1)}°`);
    // No se mete en la pared y, de media, la toca (al dejar un saliente vuelve a ella en una fracción de segundo).
    const meanGap = sumGap / count;
    assert.ok(minGap > 0.09 && meanGap < 0.15, `cadera a ${(minGap * 100).toFixed(1)} cm de la pared como mínimo y ${(meanGap * 100).toFixed(1)} de media`);
    assert.ok(human.position.z < -7, `no llegó al final (z = ${human.position.z.toFixed(2)})`);
  });

  it('pedido hacia el otro lado, frena y vuelve sin girar el cuerpo; hacia la pared o el vacío, no se mueve', () => {
    const world = ledgeWorld();
    const { human } = world;
    let maxTurn = 0;
    let stillZ = 0;
    let stoppedZ = 0;
    let moved = 0;
    let next = 0;
    simulate(world, 16, [
      [0, (h) => { h.targetSpeed = 1; }],
      [8, (h) => { h.targetHeading = Math.PI; }],
      [13, (h) => { stillZ = h.position.z; h.targetHeading = -Math.PI / 2; }],
      [14, (h) => { stoppedZ = h.position.z; }],
    ], {
      onFrame: (t) => {
        if (t >= next) {
          trace(world, t);
          next += 0.25;
        }
        if (t > 4) maxTurn = Math.max(maxTurn, angleTo(facingYaw(world), AWAY_FROM_WALL));
        if (t > 14.1) moved = Math.max(moved, Math.abs(human.position.z - stoppedZ));
      },
    });
    assert.ok(maxTurn < 1 * DEG, `el cuerpo se giró ${(maxTurn / DEG).toFixed(1)}°`);
    // A t = 8 iba por z ≈ −3,4; volviendo 5 s a 0,35 m/s (con la frenada), hacia z ≈ −2.
    assert.ok(stillZ > -2.6 && stillZ < -1.5, `a t = 13 estaba en z = ${stillZ.toFixed(2)}`);
    // Pedido hacia la pared, frena (lo que tarda en parar desde 0,35 m/s) y no se mueve más.
    assert.ok(Math.abs(stoppedZ - stillZ) < 0.1 && moved < 0.005, `pedido hacia la pared, frenó en ${(Math.abs(stoppedZ - stillZ) * 100).toFixed(1)} cm y luego se movió ${(moved * 100).toFixed(1)} cm`);
    assert.ok(human.ledge > 0.99);
  });

  for (const [x, z] of [[WALL_X - 1, 0.6], [WALL_X - 0.6, 0.2], [WALL_X - 0.3, 0.8]]) {
    it(`moveTo a la cornisa desde la plataforma (${(WALL_X - x).toFixed(1)} m de la pared): entra sin cruzar los pies ni pisar la pared (regresión)`, () => {
      // Entraba en diagonal hacia la pared, o lejos de ella, y a velocidad de caminar: el pie del lado del vacío caía más
      // allá del borde y, devuelto a la cornisa, cruzaba el otro; girando, el cuerpo se pegaba a la pared y un pie se
      // metía en ella.
      const world = ledgeWorld(x, z);
      const { human } = world;
      let inWall = -Infinity;
      let crossed = 0;
      simulate(world, 16, [[0, (h) => h.moveTo(new Vector3(WALL_X - 0.17, HEIGHT, -4))]], {
        onFrame: () => {
          for (const side of SIDES) {
            const leg = human.rig[side];
            for (const bone of [leg.foot, leg.toe ?? leg.foot]) inWall = Math.max(inWall, bone.getWorldPosition(new Vector3()).x - WALL_X);
          }
          const right = new Vector3().crossVectors(human.locomotion.body.state.forward, new Vector3(0, 1, 0));
          crossed = Math.max(crossed, -ankle(world, 'right').sub(ankle(world, 'left')).dot(right));
        },
      });
      // Las articulaciones del tobillo y de los dedos, a lo sumo a 1 cm más allá del plano de la pared.
      assert.ok(inWall < 0.01, `un pie ${(inWall * 100).toFixed(1)} cm dentro de la pared`);
      assert.ok(crossed < 0.1, `pies cruzados ${(crossed * 100).toFixed(1)} cm`);
      assert.ok(human.position.z < -3.8, `no llegó (z = ${human.position.z.toFixed(2)})`);
    });
  }

  it('parado al final de la cornisa, un destino en diagonal en la plataforma de al lado: sale de la cornisa y llega (regresión)', () => {
    // Al final de la cornisa, el destino quedaba a más de 70° de ella (hacia "el vacío", pero ahí ya está la plataforma)
    // y se quedaba quieto para siempre.
    const world = ledgeWorld();
    const { human } = world;
    simulate(world, 26, [[0, (h) => h.moveTo(new Vector3(WALL_X - 0.17, HEIGHT, -6.75))]]);
    assert.ok(human.position.z < -6.4, `no llegó al final de la cornisa (z = ${human.position.z.toFixed(2)})`);
    const target = new Vector3(WALL_X - 0.9, HEIGHT, -7.35);
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    simulate(world, 8, [[0, (h) => h.moveTo(target)]], { start: 26 });
    assert.ok(arrived, `no llegó: (${human.position.x.toFixed(2)}, ${human.position.z.toFixed(2)}), cornisa ${human.ledge.toFixed(2)}`);
    assert.ok(human.ledge < 0.01, `sigue en la cornisa (${human.ledge.toFixed(2)})`);
  });

  it('de pie en la cornisa de espaldas a la pared, la reconoce parado y sale de lado sin girarse', () => {
    // Mirando hacia −X (de espaldas a la pared): heading +90° = hacia +Z.
    const world = ledgeWorld(0.05, -4, { turn: Math.PI / 2 });
    const { human } = world;
    let maxTurn = 0;
    simulate(world, 6, [[2, (h) => { h.targetHeading = Math.PI / 2; h.targetSpeed = 0.3; }]], {
      onFrame: (t) => {
        trace(world, t);
        maxTurn = Math.max(maxTurn, angleTo(facingYaw(world), AWAY_FROM_WALL));
      },
    });
    assert.ok(human.ledge > 0.99, `ledge ${human.ledge.toFixed(2)}`);
    assert.ok(maxTurn < 3 * DEG, `el cuerpo se giró ${(maxTurn / DEG).toFixed(1)}°`);
    assert.ok(human.position.z > -3.2, `avanzó hasta z = ${human.position.z.toFixed(2)}`);
  });

  for (const stairs of [false, true]) it(`moveTo a la otra plataforma${stairs ? ', con escaleras para rodearla' : ''}: va por la cornisa, de lado, llega y sale sin un paso largo`, () => {
    const world = ledgeWorld(-0.6, 0.5, { stairs });
    const { human } = world;
    const target = new Vector3(-0.5, HEIGHT, -8.5);
    let maxLedge = 0;
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    let next = 0;
    // Saliendo de la cornisa, lo que separa los pies cada vez que uno aterriza (regresión: un paso de 1–1,2 m).
    const inAir = { left: false, right: false };
    let exitStep = 0;
    simulate(world, 30, [[0, (h) => { h.moveTo(target); }]], {
      onFrame: (t) => {
        if (t >= next) {
          trace(world, t);
          next += 0.25;
        }
        maxLedge = Math.max(maxLedge, human.ledge);
        for (const side of SIDES) {
          const air = human.footPhase(side) === 'SWING';
          if (inAir[side] && !air && maxLedge > 0.99 && human.ledge < 1) exitStep = Math.max(exitStep, ankle(world, 'left').distanceTo(ankle(world, 'right')));
          inAir[side] = air;
        }
      },
    });
    assert.ok(maxLedge > 0.99, `ledge ${maxLedge.toFixed(2)}`);
    assert.ok(exitStep < 0.8, `al salir de la cornisa, un paso de ${exitStep.toFixed(2)} m`);
    assert.ok(arrived, `no llegó (en ${human.position.x.toFixed(2)}, ${human.position.y.toFixed(2)}, ${human.position.z.toFixed(2)}; ruta ${human.movePath?.map((p) => `(${p.x.toFixed(1)},${p.z.toFixed(1)})`).join(' ')})`);
    assert.ok(human.position.distanceTo(target) < 0.3, `acabó a ${human.position.distanceTo(target).toFixed(2)} m`);
  });

  for (const [name, options] of [
    ['con ledgeWidth 0', { config: true }],
    ['junto a una pared sin caída (un pasillo)', { noDrop: true }],
    ['con una pared baja (un parapeto de 60 cm)', { wall: 0.6 }],
    ['en una cornisa más ancha que ledgeWidth', { width: 0.6 }],
  ] as const) {
    it(`${name}, camina de frente`, () => {
      const world = ledgeWorld(0, 0, options as LedgeOptions);
      const { human } = world;
      if ('config' in options) human.setConfig({ ledgeWidth: 0 });
      let maxLedge = 0;
      let maxTurn = 0;
      simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }]], {
        onFrame: () => {
          maxLedge = Math.max(maxLedge, human.ledge);
          maxTurn = Math.max(maxTurn, angleTo(facingYaw(world), Math.PI));
        },
      });
      assert.equal(maxLedge, 0);
      assert.ok(maxTurn < 5 * DEG, `se giró ${(maxTurn / DEG).toFixed(1)}°`);
      assert.ok(human.position.z < -5, `no avanzó (z = ${human.position.z.toFixed(2)})`);
    });
  }
});
