import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, CylinderGeometry, Mesh, MeshBasicMaterial, type Object3D, type Quaternion, Vector3 } from 'three';

import { createGroundHit, defaultConfig, RaycastGroundDetector, type Side } from '../src/index.ts';
import { createWorld, DEG, SIDES, simulate, type World } from './helpers/sim.ts';

/** Primer borde, a esta distancia por delante del personaje (m, hacia −Z). */
const START = 2;
const COUNT = 8;

/** Bloque macizo de `height` m, de z = `zNear` a z = `zFar` (zFar < zNear). */
function addBlock(terrain: Object3D, height: number, zNear: number, zFar: number): void {
  const mesh = new Mesh(new BoxGeometry(1.6, height, zNear - zFar), new MeshBasicMaterial());
  mesh.position.set(0, height / 2, (zNear + zFar) / 2);
  terrain.add(mesh);
}

/** Placa de 4 cm de grosor con la cara de arriba a `height` m, de z = `zNear` a z = `zFar`. */
function addSlab(terrain: Object3D, height: number, zNear: number, zFar: number): void {
  const mesh = new Mesh(new BoxGeometry(1.6, 0.04, zNear - zFar), new MeshBasicMaterial());
  mesh.position.set(0, height - 0.02, (zNear + zFar) / 2);
  terrain.add(mesh);
}

interface StairsOptions {
  down?: boolean;
  /** Sin contrahuella: huellas de 4 cm de grosor con este hueco horizontal entre una y otra (m). */
  gap?: number;
  /** Sin suelo al alcance debajo de la escalera (el plano del terreno baja a −5 m). */
  overVoid?: boolean;
}

/**
 * Tramo recto de escalera hacia −Z con `COUNT` contrahuellas de `rise` y huellas de `run` (m), de bloques
 * macizos o sin contrahuella. Hacia arriba: arranca en el suelo y acaba en un rellano de 8 m. Hacia abajo: el
 * personaje empieza en un rellano y baja hasta el suelo. Devuelve la altura a la que termina.
 */
function addStairs(terrain: Object3D, rise: number, run: number, options: StairsOptions = {}): number {
  const { down = false, gap } = options;
  const tread = (height: number, zNear: number, zFar: number): void => {
    if (gap === undefined) addBlock(terrain, height, zNear, zFar);
    else addSlab(terrain, height, zNear - gap / 2, zFar + gap / 2);
  };
  if (down) {
    addBlock(terrain, rise * COUNT, 3, -START);
    for (let i = 1; i < COUNT; i++) tread(rise * (COUNT - i), -START - run * (i - 1), -START - run * i);
  } else {
    for (let i = 0; i < COUNT - 1; i++) tread(rise * (i + 1), -START - run * i, -START - run * (i + 1));
    addBlock(terrain, rise * COUNT, -START - run * (COUNT - 1), -START - run * (COUNT - 1) - 8);
  }
  if (options.overVoid) {
    terrain.children[0].position.y = -5;
    if (down) addSlab(terrain, 0, -START - run * (COUNT - 1), -START - run * (COUNT - 1) - 8);
    else addSlab(terrain, 0, 5, -START);
  }
  terrain.updateMatrixWorld(true);
  return down ? 0 : rise * COUNT;
}

/**
 * Talón (detrás del tobillo; con `underAnkle`, bajo el tobillo) y punta de los dedos de un pie, a la altura
 * de la planta (world).
 */
function sole(world: World, side: Side, underAnkle = false): { heel: Vector3; tip: Vector3 } {
  const { human } = world;
  const loco = human.locomotion;
  const ankle = human.rig[side].foot.getWorldPosition(new Vector3());
  const dir = human.rig[side].toe!.getWorldPosition(new Vector3()).sub(ankle).setY(0).normalize();
  const y = loco.feet[side].position.y - loco.planner.placement(side).ankleHeight;
  return {
    heel: ankle.clone().addScaledVector(dir, underAnkle ? 0 : -loco.stairs.heelBack).setY(y),
    tip: ankle.clone().addScaledVector(dir, loco.stairs.toeFront).setY(y),
  };
}

interface StairRun {
  /** Peor diferencia entre la planta de un pie apoyado y plano (talón y punta) y el suelo bajo ella (m). */
  worstStance: number;
  /** Lo más que la articulación de los dedos o el tobillo se metió en la escalera en el aire (m, ≥ 0). */
  worstSwing: number;
  /** Escalón (0 = el suelo) de cada aterrizaje, en orden. */
  landings: number[];
  slip: number;
  stanceIK: number;
  alternates: boolean;
}

/** El pie está plano: lo que lo separa de su pose apoyada es solo un giro sobre la vertical (el pivote). */
function flat(foot: { rotation: Quaternion; plantedRotation: Quaternion }): boolean {
  const relative = foot.rotation.clone().multiply(foot.plantedRotation.clone().invert());
  return new Vector3(0, 1, 0).applyQuaternion(relative).angleTo(new Vector3(0, 1, 0)) < 1e-3;
}

interface SpiralOptions {
  /** Radio de la escalera (m) y radio por el que se camina (m). */
  outer: number;
  walkRadius: number;
  /** Ángulo de cada escalón (°) y contrahuella (m). */
  stepDeg: number;
  rise: number;
  count: number;
  down?: boolean;
  /** Gira hacia la derecha (por defecto, hacia la izquierda). */
  right?: boolean;
}

/**
 * Escalera en curva o de caracol, de cuñas macizas: el centro, a un lado del personaje (que mira hacia −Z), a
 * `walkRadius`; el primer escalón, 45° más allá. Hacia arriba acaba en un rellano de 30°; hacia abajo
 * empieza en uno. Devuelve la altura a la que termina.
 */
function addSpiral(terrain: Object3D, o: SpiralOptions): number {
  const side = o.right ? -1 : 1;
  const material = new MeshBasicMaterial();
  // Cuña de `height` m entre los ángulos a0 y a1 (°, desde la posición inicial hacia donde gira).
  const wedge = (height: number, a0: number, a1: number): void => {
    // Segmentos para que el borde no se aparte más de 1 mm del círculo.
    const segments = Math.max(4, Math.ceil(((a1 - a0) * DEG) / (2 * Math.acos(1 - 0.001 / o.outer))));
    const thetaStart = side > 0 ? 90 + a0 : 270 - a1;
    const mesh = new Mesh(new CylinderGeometry(o.outer, o.outer, height, segments, 1, false, thetaStart * DEG, (a1 - a0) * DEG), material);
    mesh.position.set(-side * o.walkRadius, height / 2, 0);
    terrain.add(mesh);
  };
  const start = 45;
  const top = o.rise * o.count;
  if (o.down) {
    wedge(top, -8, start);
    for (let i = 1; i < o.count; i++) wedge(o.rise * (o.count - i), start + o.stepDeg * (i - 1), start + o.stepDeg * i);
  } else {
    for (let i = 0; i < o.count - 1; i++) wedge(o.rise * (i + 1), start + o.stepDeg * i, start + o.stepDeg * (i + 1));
    wedge(top, start + o.stepDeg * (o.count - 1), start + o.stepDeg * (o.count - 1) + 30);
  }
  terrain.updateMatrixWorld(true);
  return o.down ? 0 : top;
}

/**
 * Lleva al personaje por la circunferencia de `walkRadius`, como haría quien lo controla, y lo para 15°
 * después del último escalón.
 */
function steerAround(o: SpiralOptions): (human: World['human']) => void {
  const side = o.right ? -1 : 1;
  const cx = -side * o.walkRadius;
  const stop = (45 + o.stepDeg * (o.count - 1) + 15) * DEG;
  let turned = 0;
  let last = 0;
  return (human) => {
    const p = human.position;
    const angle = Math.atan2(-p.z, side * (p.x - cx));
    turned += Math.atan2(Math.sin(angle - last), Math.cos(angle - last));
    last = angle;
    human.targetHeading = side * (turned + 1.5 * (Math.hypot(p.x - cx, p.z) - o.walkRadius));
    if (turned > stop) human.targetSpeed = 0;
  };
}

/**
 * Camina a 1 m/s durante `seconds` s (en línea recta, o guiado por `steer` cada frame) y mide los pies contra
 * la escalera de contrahuella `rise`. Con `underAnkle`, el talón se mide bajo el tobillo (sin contrahuella, en
 * una huella corta sobresale sobre el hueco, como el de una persona).
 */
function climb(world: World, rise: number, seconds: number, underAnkle = false, steer?: (human: World['human']) => void): StairRun {
  const { human, terrain } = world;
  const loco = human.locomotion;
  const detector = new RaycastGroundDetector([terrain]);
  const hit = createGroundHit();
  const ground = (p: Vector3): number => (detector.castDown(new Vector3(p.x, p.y + 2, p.z), 5, hit) ? hit.point.y : Number.NEGATIVE_INFINITY);
  const result: StairRun = { worstStance: 0, worstSwing: 0, landings: [], slip: 0, stanceIK: 0, alternates: true };
  const previous: Record<Side, string> = { left: loco.feet.left.phase, right: loco.feet.right.phase };
  steer?.(human);
  const r = simulate(world, seconds, [[0, (h) => { h.targetSpeed = 1; }]], {
    onFrame: () => {
      steer?.(human);
      for (const side of SIDES) {
        const foot = loco.feet[side];
        if (foot.phase === 'PLANTED') {
          // Con el pie ya plano (al pararse, se aplana poco a poco desde el talón levantado).
          const { heel, tip } = sole(world, side, underAnkle);
          if (flat(foot)) result.worstStance = Math.max(result.worstStance, Math.abs(heel.y - ground(heel)), Math.abs(tip.y - ground(tip)));
          if (previous[side] !== 'PLANTED') result.landings.push(Math.round(ground(foot.position) / rise));
        } else if (foot.phase === 'SWING') {
          for (const bone of [human.rig[side].toe!, human.rig[side].foot]) {
            const p = bone.getWorldPosition(new Vector3());
            result.worstSwing = Math.max(result.worstSwing, ground(p) - p.y);
          }
        }
        previous[side] = foot.phase;
      }
    },
  });
  result.slip = r.slip;
  result.stanceIK = r.stanceIK;
  result.alternates = r.alternates;
  return result;
}

describe('escaleras', () => {
  // Contrahuella × huella (m): baja y larga, estándar, empinada y casi tan alta como maxStepUp/maxStepDown.
  const sizes: [number, number][] = [[0.1, 0.4], [0.17, 0.28], [0.22, 0.25], [0.3, 0.3]];
  for (const down of [false, true]) {
  for (const [rise, run] of sizes) {
    it(`${down ? 'baja' : 'sube'} ${Math.round(rise * 100)} × ${Math.round(run * 100)} cm: un escalón por paso, el pie entero en la huella, sin atravesarla`, () => {
      let end = 0;
      const world = createWorld({
        buildTerrain: (terrain) => { end = addStairs(terrain, rise, run, { down }); },
        // Bajando, empieza arriba (desde el suelo, el rellano queda fuera de la sonda de la raíz).
        place: (model, scene) => { model.position.y = down ? rise * COUNT : 0; scene.add(model); },
      });
      const r = climb(world, rise, 12);
      assert.ok(r.slip < 1e-6, `un pie apoyado se deslizó ${(r.slip * 1000).toFixed(2)} mm`);
      assert.ok(r.stanceIK < 0.001, `error de IK en apoyo ${(r.stanceIK * 1000).toFixed(2)} mm`);
      assert.ok(r.alternates, 'pasos no alternados');
      assert.ok(r.worstStance < 0.01, `un pie apoyado sobresale de la huella o se mete en el escalón ${(r.worstStance * 100).toFixed(1)} cm`);
      assert.ok(r.worstSwing < 0.005, `un pie en el aire se mete en la escalera ${(r.worstSwing * 100).toFixed(1)} cm`);
      // De uno en uno: ningún pie aterriza más de un escalón más allá que el anterior, y pisa todos.
      for (let i = 1; i < r.landings.length; i++) {
        assert.ok(Math.abs(r.landings[i] - r.landings[i - 1]) <= 1, `se saltó un escalón: ${r.landings.join(' ')}`);
      }
      const steps = new Set(r.landings.filter((s) => s > 0 && s < COUNT));
      assert.equal(steps.size, COUNT - 1, `no pisó todos los escalones: ${r.landings.join(' ')}`);
      assert.ok(Math.abs(world.human.position.y - end) < 0.02, `no llegó al final (raíz a ${world.human.position.y.toFixed(2)} m de ${end.toFixed(2)})`);
    });
  }
  }

  // Sin contrahuella: con el suelo debajo y sobre el vacío (sin suelo al alcance bajo la escalera).
  for (const down of [false, true]) {
    for (const overVoid of [false, true]) {
      it(`${down ? 'baja' : 'sube'} sin contrahuella (huecos de 4 cm${overVoid ? ', sobre el vacío' : ''}): salta los huecos y pisa todas las huellas`, () => {
        const rise = 0.17;
        let end = 0;
        const world = createWorld({
          buildTerrain: (terrain) => { end = addStairs(terrain, rise, 0.28, { down, gap: 0.04, overVoid }); },
          place: (model, scene) => { model.position.y = down ? rise * COUNT : 0; scene.add(model); },
        });
        const r = climb(world, rise, 12, true);
        assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, 'marcha sucia');
        assert.ok(r.worstStance < 0.01, `un pie apoyado pisa el hueco o se mete en la huella ${(r.worstStance * 100).toFixed(1)} cm`);
        assert.ok(r.worstSwing < 0.005, `un pie en el aire se mete en la escalera ${(r.worstSwing * 100).toFixed(1)} cm`);
        assert.ok(world.human.locomotion.body.state.grounded, 'se quedó sin suelo');
        const steps = new Set(r.landings.filter((s) => s > 0 && s < COUNT));
        assert.equal(steps.size, COUNT - 1, `no pisó todas las huellas: ${r.landings.join(' ')}`);
        assert.ok(Math.abs(world.human.position.y - end) < 0.02, `no llegó al final (raíz a ${world.human.position.y.toFixed(2)} m)`);
      });
    }
  }

  // En curva y de caracol: quien lo controla lo lleva girando por la escalera.
  const spirals: [string, SpiralOptions][] = [
    ['de caracol (radio 1,4 m, a 0,85 m del centro)', { outer: 1.4, walkRadius: 0.85, stepDeg: 22.5, rise: 0.18, count: 12 }],
    ['de caracol hacia la derecha', { outer: 1.4, walkRadius: 0.85, stepDeg: 22.5, rise: 0.18, count: 12, right: true }],
    ['en curva (radio 5 m)', { outer: 5, walkRadius: 3.5, stepDeg: 6, rise: 0.17, count: 10 }],
  ];
  for (const [name, spiral] of spirals) {
    for (const down of [false, true]) {
      it(`${down ? 'baja' : 'sube'} una escalera ${name}: un escalón por paso, el pie entero en la huella`, () => {
        const o = { ...spiral, down };
        let end = 0;
        const world = createWorld({
          buildTerrain: (terrain) => { end = addSpiral(terrain, o); },
          place: (model, scene) => { model.position.y = down ? o.rise * o.count : 0; scene.add(model); },
        });
        const r = climb(world, o.rise, 11, false, steerAround(o));
        assert.ok(r.slip < 1e-6, `un pie apoyado se deslizó ${(r.slip * 1000).toFixed(2)} mm`);
        assert.ok(r.stanceIK < 0.001, `error de IK en apoyo ${(r.stanceIK * 1000).toFixed(2)} mm`);
        assert.ok(r.alternates, 'pasos no alternados');
        assert.ok(r.worstStance < 0.01, `un pie apoyado sobresale de la huella o se mete en el escalón ${(r.worstStance * 100).toFixed(1)} cm`);
        assert.ok(r.worstSwing < 0.005, `un pie en el aire se mete en la escalera ${(r.worstSwing * 100).toFixed(1)} cm`);
        for (let i = 1; i < r.landings.length; i++) {
          assert.ok(Math.abs(r.landings[i] - r.landings[i - 1]) <= 1, `se saltó un escalón: ${r.landings.join(' ')}`);
        }
        const steps = new Set(r.landings.filter((s) => s > 0 && s < o.count));
        assert.equal(steps.size, o.count - 1, `no pisó todos los escalones: ${r.landings.join(' ')}`);
        assert.ok(Math.abs(world.human.position.y - end) < 0.05, `no llegó al final (raíz a ${world.human.position.y.toFixed(2)} m de ${end.toFixed(2)})`);
      });
    }
  }

  it('una contrahuella más alta que maxStepUp es una pared: se para delante, quieto y sin meter los pies', () => {
    const rise = defaultConfig.maxStepUp + 0.05;
    const world = createWorld({ buildTerrain: (terrain) => addStairs(terrain, rise, 0.3) });
    const r = climb(world, rise, 8);
    assert.equal(world.human.gaitMode, 'idle');
    assert.ok(world.human.position.y < 0.01, `subió (raíz a ${world.human.position.y.toFixed(2)} m)`);
    assert.ok(r.worstStance < 0.01, `un pie apoyado pisa el borde ${(r.worstStance * 100).toFixed(1)} cm`);
    assert.ok(r.worstSwing < 0.005, `un pie se mete en el escalón ${(r.worstSwing * 100).toFixed(1)} cm`);
    for (const side of SIDES) {
      const { tip } = sole(world, side);
      assert.ok(tip.z > -START, `la punta del pie ${side} pasó la contrahuella (z ${tip.z.toFixed(2)})`);
    }
  });

  it('de un desnivel más hondo que maxStepDown no baja: se para en el borde, quieto', () => {
    const drop = defaultConfig.maxStepDown + 0.05;
    const world = createWorld({ buildTerrain: (terrain) => addBlock(terrain, drop, 3, -START) });
    const r = climb(world, drop, 8);
    assert.equal(world.human.gaitMode, 'idle');
    assert.ok(Math.abs(world.human.position.y - drop) < 0.01, `bajó (raíz a ${world.human.position.y.toFixed(2)} m)`);
    assert.ok(r.worstStance < 0.01, `un pie apoyado sobresale del borde ${(r.worstStance * 100).toFixed(1)} cm`);
    for (const side of SIDES) {
      const { tip } = sole(world, side);
      assert.ok(tip.z > -START, `la punta del pie ${side} pasó el borde (z ${tip.z.toFixed(2)})`);
    }
  });
});
