import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three';

import { createGroundHit, defaultConfig, mapHumanRig, RaycastGroundDetector, type Side } from '../src/index.ts';
import { createWorld, DEG, MODEL_MAPPING, SIDES, simulate, type World } from './helpers/sim.ts';

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

/**
 * Pone al modelo una malla con piel mínima, en los huesos de los pies: vértices de la planta con la punta a
 * `front` m delante del tobillo y el talón a `back` m detrás (para medirla: ver measureFeet).
 */
function addFeetMesh(model: Object3D, front: number, back: number): void {
  model.updateMatrixWorld(true);
  const { rig } = mapHumanRig(model, MODEL_MAPPING);
  const positions: number[] = [];
  const indices: number[] = [];
  const weights: number[] = [];
  SIDES.forEach((side, bone) => {
    const ankle = rig[side].foot.getWorldPosition(new Vector3());
    const dir = rig[side].toe!.getWorldPosition(new Vector3()).sub(ankle).setY(0).normalize();
    const across = new Vector3(-dir.z, 0, dir.x).multiplyScalar(0.04);
    for (const d of [front, -back, 0]) {
      for (const s of [-1, 1]) {
        for (const y of [0.005, 0.03]) {
          const p = model.worldToLocal(ankle.clone().addScaledVector(dir, d).addScaledVector(across, s).setY(model.position.y + y));
          positions.push(p.x, p.y, p.z);
          indices.push(bone, 0, 0, 0);
          weights.push(1, 0, 0, 0);
        }
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  model.add(mesh);
  model.updateMatrixWorld(true);
  mesh.bind(new Skeleton([rig.left.foot, rig.right.foot]));
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

  // Click-to-move junto a un desnivel de 1 m (el diorama): varios moveTo seguidos contra el borde, en diagonal y a
  // lo largo de él. Antes la raíz cruzaba el borde (la pared se veía tarde, o al girar el perfil la tomaba por
  // escalones) y el personaje subía o bajaba el metro.
  const ledgeRoutes: [string, [t: number, x: number, z: number][]][] = [
    ['clics seguidos contra el borde', [[0, 0, -START], [3, 0.3, -START - 1], [4, -0.3, -START], [5, 0.2, -START - 0.3], [6.5, 0.5, -START - 2]]],
    ['en diagonal, a un lado y al otro', [[0, 2, -4], [3, -2, -4], [5, 1, -3]]],
    ['a lo largo del borde y después hacia él', [[0, 0, -START + 0.4], [2.5, 2.5, -START + 0.2], [5, -2.5, -START + 0.3], [8, 0, -3]]],
  ];
  for (const down of [false, true]) {
    for (const [name, route] of ledgeRoutes) {
      it(`${down ? 'bajando' : 'subiendo'}, desnivel de 1 m con moveTo ${name}: ni lo cruza ni frena de golpe`, () => {
        const level = down ? 1 : 0;
        const world = createWorld({
          buildTerrain: (terrain) => {
            const mesh = new Mesh(new BoxGeometry(6, 1, 8), new MeshBasicMaterial());
            mesh.position.set(0, 0.5, down ? -START + 4 : -START - 4);
            terrain.add(mesh);
          },
          place: (model, scene) => { model.position.y = level; scene.add(model); },
        });
        const { human } = world;
        const loco = human.locomotion;
        let worstRoot = 0;
        let worstFoot = 0;
        let closest = Number.POSITIVE_INFINITY;
        let worstBrake = 0;
        let speed = 0;
        const target = (x: number, z: number): Vector3 => new Vector3(x, z < -START ? 1 : 0, z);
        simulate(world, 10, route.map(([t, x, z]) => [t, (h) => h.moveTo(target(x, z), { avoid: false })]), {
          onFrame: () => {
            worstRoot = Math.max(worstRoot, Math.abs(human.position.y - level));
            closest = Math.min(closest, human.position.z + START);
            worstBrake = Math.max(worstBrake, speed - human.speed);
            speed = human.speed;
            for (const side of SIDES) {
              const foot = loco.feet[side];
              if (foot.phase === 'SWING') continue;
              worstFoot = Math.max(worstFoot, Math.abs(foot.planted.y - loco.planner.placement(side).ankleHeight - level));
              closest = Math.min(closest, human.rig[side].toe!.getWorldPosition(new Vector3()).z + START);
            }
          },
        });
        assert.ok(worstRoot < 0.01, `la raíz cambió de nivel ${worstRoot.toFixed(2)} m`);
        assert.ok(worstFoot < 0.01, `un pie apoyado cambió de nivel ${worstFoot.toFixed(2)} m`);
        assert.ok(closest > 0, `la raíz o un pie apoyado pasó el borde ${(-closest * 100).toFixed(1)} cm`);
        // Frenando normal, menos de 0,07 m/s por frame (deceleration 2,5 m/s², hasta × 1,6 al pivotar).
        assert.ok(worstBrake < 0.1, `frenó de golpe ${worstBrake.toFixed(2)} m/s en un frame`);
      });
    }
  }

  // Junto a la esquina del mismo bloque (x = 3): parado ante el borde, se lo manda a pasar por fuera de la esquina
  // o a lo largo del borde. Antes la pared se daba por más larga de lo que es (y su normal salía torcida): no
  // arrancaba.
  const cornerRoutes: [string, [t: number, x: number, z: number][], arrives: boolean][] = [
    ['por fuera de la esquina', [[0, 2.7, -1.7], [4, 5, -3]], true],
    ['a lo largo del borde, más allá de la esquina', [[0, 2.7, -1.7], [4, 5, -1.6]], true],
    ['hacia el bloque, cerca de la esquina', [[0, 2.6, -1.6], [4, 3.6, -5]], false],
  ];
  for (const [name, route, arrives] of cornerRoutes) {
    it(`junto a la esquina de un desnivel de 1 m, moveTo ${name}: ${arrives ? 'llega' : 'se para'} sin subirlo`, () => {
      const world = createWorld({
        buildTerrain: (terrain) => {
          const mesh = new Mesh(new BoxGeometry(6, 1, 8), new MeshBasicMaterial());
          mesh.position.set(0, 0.5, -START - 4);
          terrain.add(mesh);
        },
      });
      const { human } = world;
      const loco = human.locomotion;
      // Cuánto se mete en el bloque (> 0: dentro) un punto.
      const inside = (p: Vector3): number => Math.min(3 - p.x, -START - p.z);
      let worstY = 0;
      let deepest = Number.NEGATIVE_INFINITY;
      let worstBrake = 0;
      let speed = 0;
      simulate(world, 12, route.map(([t, x, z]) => [t, (h) => h.moveTo(new Vector3(x, 0, z), { avoid: false })]), {
        onFrame: () => {
          worstY = Math.max(worstY, Math.abs(human.position.y));
          deepest = Math.max(deepest, inside(human.position));
          worstBrake = Math.max(worstBrake, speed - human.speed);
          speed = human.speed;
          for (const side of SIDES) {
            if (loco.feet[side].phase === 'SWING') continue;
            worstY = Math.max(worstY, Math.abs(loco.feet[side].planted.y - loco.planner.placement(side).ankleHeight));
            deepest = Math.max(deepest, inside(human.rig[side].toe!.getWorldPosition(new Vector3())));
          }
        },
      });
      const [, x, z] = route[route.length - 1];
      const left = Math.hypot(human.position.x - x, human.position.z - z);
      if (arrives) assert.ok(left < 0.3, `se quedó a ${left.toFixed(2)} m del destino`);
      else assert.ok(left > 1, 'cruzó el bloque');
      assert.ok(worstY < 0.01, `cambió de nivel ${worstY.toFixed(2)} m`);
      assert.ok(deepest < 0, `la raíz o un pie apoyado se metió ${(deepest * 100).toFixed(1)} cm en el bloque`);
      assert.ok(worstBrake < 0.1, `frenó de golpe ${worstBrake.toFixed(2)} m/s en un frame`);
    });
  }

  // Bloques más altos que groundProbeHeight (1,5 m) sobre el suelo de al lado: el rayo que busca el suelo empieza
  // dentro de ellos. Antes no los veía y el personaje se metía (en la tarima de 1,7 m del caracol del Laboratorio).
  // Ahora son una pared: se para delante sin meterse, o los rodea con moveTo, o sube por su escalera.
  for (const [height, avoid] of [[1.7, false], [3, false], [3, true]] as const) {
    it(`un bloque de ${height} m: ${avoid ? 'moveTo detrás de él lo rodea' : 'moveTo contra él se para delante'}, sin meterse`, () => {
      const world = createWorld({
        buildTerrain: (terrain) => {
          const mesh = new Mesh(new BoxGeometry(3, height, 3), new MeshBasicMaterial());
          mesh.position.set(0, height / 2, -START - 1.5);
          terrain.add(mesh);
        },
      });
      const { human } = world;
      const loco = human.locomotion;
      const inside = (p: Vector3): number => Math.min(1.5 - Math.abs(p.x), -START - p.z, p.z + START + 3);
      let deepest = Number.NEGATIVE_INFINITY;
      let worstY = 0;
      const target = new Vector3(0, 0, -START - 4.5);
      simulate(world, 14, [[0, (h) => h.moveTo(target, { avoid })]], {
        onFrame: () => {
          worstY = Math.max(worstY, Math.abs(human.position.y));
          deepest = Math.max(deepest, inside(human.position));
          for (const side of SIDES) {
            if (loco.feet[side].phase === 'SWING') continue;
            worstY = Math.max(worstY, Math.abs(loco.feet[side].planted.y - loco.planner.placement(side).ankleHeight));
            deepest = Math.max(deepest, inside(human.rig[side].toe!.getWorldPosition(new Vector3())));
          }
        },
      });
      assert.ok(deepest < 0, `la raíz o un pie apoyado se metió ${(deepest * 100).toFixed(1)} cm en el bloque`);
      assert.ok(worstY < 0.01, `cambió de nivel ${worstY.toFixed(2)} m`);
      const left = human.position.distanceTo(target);
      if (avoid) assert.ok(left < 0.3, `se quedó a ${left.toFixed(2)} m del destino`);
      else assert.ok(human.speed < 0.05 && human.position.z > -START, `no se paró delante (z ${human.position.z.toFixed(2)}, ${human.speed.toFixed(2)} m/s)`);
    });
  }

  it('una tarima de 1,7 m con escalera: moveTo arriba desde el suelo, por el lado sin escalera, sube por ella', () => {
    // Tarima de x −1,5 a 1,5 y de z −3 a −6, con la escalera (10 × 17 cm) en su cara de +X; destino en el medio.
    const top = 1.7;
    const world = createWorld({
      buildTerrain: (terrain) => {
        const deck = new Mesh(new BoxGeometry(3, top, 3), new MeshBasicMaterial());
        deck.position.set(0, top / 2, -4.5);
        terrain.add(deck);
        for (let k = 1; k < 10; k++) {
          const step = new Mesh(new BoxGeometry(0.28, 0.17 * k, 1.2), new MeshBasicMaterial());
          step.position.set(1.5 + 0.28 * (10 - k - 0.5), 0.085 * k, -4.5);
          terrain.add(step);
        }
      },
    });
    const { human } = world;
    let inside = false;
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    simulate(world, 20, [[0, (h) => h.moveTo(new Vector3(0, top, -4.5))]], {
      onFrame: () => {
        const p = human.position;
        // Dentro de su planta y muy por debajo de su cara de arriba (al subir el último escalón, la raíz sube suavizada).
        if (Math.abs(p.x) < 1.3 && p.z < -3.2 && p.z > -5.8 && p.y < top - 0.3) inside = true;
      },
    });
    assert.ok(!inside, 'se metió en la tarima');
    assert.ok(arrived && Math.abs(human.position.y - top) < 0.01, `no llegó arriba (raíz a ${human.position.y.toFixed(2)} m)`);
  });

  // La plataforma del Laboratorio: 1,02 m, de x 3 a 6,5 y de z −2 a 4, con una escalera en la cara de +X
  // (z 1,9–3,3). Recorridos al azar (repetibles) desde arriba y desde abajo, con clics a los dos niveles,
  // algunos dobles. Antes: subía o bajaba por los bordes, un pie apoyaba en el otro nivel, y parado junto al
  // borde la raíz quedaba sobre él (el cuerpo inclinado) y los pies se recolocaban sin parar o se alejaban.
  for (const avoid of [false, true]) it(`plataforma de 1 m con escalera, clics al azar ${avoid ? 'con ruta' : 'en línea recta'}: solo cambia de nivel por la escalera y para bien`, () => {
    const top = 1.02;
    const onTop = (x: number, z: number): boolean => x > 3 && x < 6.5 && z > -2 && z < 4;
    const heightAt = (x: number, z: number): number => {
      if (onTop(x, z)) return top;
      if (x >= 6.5 && x < 6.5 + 5 * 0.28 && z > 1.9 && z < 3.3) return 0.17 * (5 - Math.floor((x - 6.5) / 0.28));
      return 0;
    };
    const box = (t: Object3D, w: number, h: number, d: number, x: number, z: number): void => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
      mesh.position.set(x, h / 2, z);
      t.add(mesh);
    };
    const problems: string[] = [];
    for (let i = 0; i < 24; i++) {
      // mulberry32
      let seed = 100 + i;
      const random = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
      const start = i % 2 === 0 ? new Vector3(3.3 + random() * 2.9, top, -1.7 + random() * 5.4) : new Vector3(1.5 + random() * 1.2, 0, -1 + random() * 4);
      const clicks: [number, number, number][] = [];
      let end = 0;
      for (let k = 0; k < 4; k++) {
        const x = 1 + random() * 7;
        const z = -4 + random() * 9;
        clicks.push([end, x, z]);
        if (random() < 0.6) clicks.push([end + 0.15 + random() * 0.2, x, z]);
        end += 1 + random() * 2.5;
      }
      const world = createWorld({
        buildTerrain: (t) => {
          box(t, 3.5, top, 6, 4.75, 1);
          for (let k = 1; k < 6; k++) box(t, 0.28, 0.17 * k, 1.4, 6.5 + 0.28 * (5 - k + 0.5), 2.6);
        },
        place: (model, scene) => { model.position.copy(start); scene.add(model); },
      });
      const { human } = world;
      const loco = human.locomotion;
      let wasTop = onTop(start.x, start.z);
      let crossed = '';
      let worstFoot = 0;
      let worstOffset = 0;
      simulate(world, end + 3, clicks.map(([t, x, z]) => [t, (h) => h.moveTo(new Vector3(x, 0, z), { avoid })]), {
        onFrame: (t) => {
          const p = human.position;
          const isTop = onTop(p.x, p.z);
          if (isTop !== wasTop && !crossed && !(p.x > 6.3 && p.z > 1.9 && p.z < 3.3)) crossed = `t ${t.toFixed(2)}`;
          wasTop = isTop;
          for (const side of SIDES) {
            const foot = loco.feet[side];
            if (foot.phase === 'SWING') continue;
            const ground = foot.planted.y - loco.planner.placement(side).ankleHeight;
            worstFoot = Math.max(worstFoot, Math.abs(ground - heightAt(foot.planted.x, foot.planted.z)));
          }
          if (human.gaitMode === 'idle') {
            const l = loco.feet.left.planted;
            const r = loco.feet.right.planted;
            worstOffset = Math.max(worstOffset, Math.hypot(p.x - (l.x + r.x) / 2, p.z - (l.z + r.z) / 2));
          }
        },
      });
      if (crossed) problems.push(`${i}: cruzó un borde (${crossed})`);
      if (worstFoot > 0.03) problems.push(`${i}: un pie apoyado a ${worstFoot.toFixed(2)} m del suelo bajo él`);
      if (worstOffset > 0.12) problems.push(`${i}: parado, la raíz a ${worstOffset.toFixed(2)} m de entre los pies`);
    }
    assert.deepEqual(problems, []);
  });

  // Un pie largo por delante de la articulación de los dedos, como el del modelo del diorama (la punta a 25 cm
  // del tobillo y el talón bajo él): medido en la malla, la punta no entra en las contrahuellas. Antes se
  // suponían las proporciones (la punta a 1,35 pies del tobillo, unos 16 cm) y, subiendo escalones de 25 × 35
  // cm, entraba 7,5 cm.
  for (const down of [false, true]) {
    it(`${down ? 'bajando' : 'subiendo'} escalones de 25 × 35 cm con un pie largo, medido en la malla: la punta no entra en la contrahuella`, () => {
      const rise = 0.25;
      const run = 0.35;
      const front = 0.25;
      const world = createWorld({
        buildTerrain: (terrain) => addStairs(terrain, rise, run, { down }),
        place: (model, scene) => {
          if (down) model.position.y = rise * COUNT;
          scene.add(model);
          addFeetMesh(model, front, 0.01);
        },
      });
      const { human, terrain } = world;
      assert.ok(Math.abs(human.locomotion.stairs.toeFront - front) < 1e-3, `midió la punta a ${human.locomotion.stairs.toeFront.toFixed(3)} m`);
      assert.ok(Math.abs(human.locomotion.stairs.heelBack - 0.01) < 1e-3, `midió el talón a ${human.locomotion.stairs.heelBack.toFixed(3)} m`);
      const detector = new RaycastGroundDetector([terrain]);
      const hit = createGroundHit();
      const ground = (p: Vector3): number => (detector.castDown(new Vector3(p.x, p.y + 0.6, p.z), 5, hit) ? hit.point.y : Number.NEGATIVE_INFINITY);
      let worst = 0;
      let top = 0;
      simulate(world, 9, [[0, (h) => { h.targetSpeed = 1; }]], {
        onFrame: () => {
          top = Math.max(top, Math.abs(human.position.y - (down ? rise * COUNT : 0)));
          for (const side of SIDES) {
            const foot = human.locomotion.feet[side];
            if (foot.phase !== 'PLANTED' && foot.phase !== 'PLANT') continue;
            const ankle = human.rig[side].foot.getWorldPosition(new Vector3());
            const dir = human.rig[side].toe!.getWorldPosition(new Vector3()).sub(ankle).setY(0).normalize();
            const sole = foot.planted.y - human.locomotion.planner.placement(side).ankleHeight + 0.01;
            const tip = ankle.clone().addScaledVector(dir, front).setY(sole);
            // Dentro de un escalón: cuánto (en horizontal) hasta salir de él.
            let d = 0;
            while (d < 0.4 && ground(tip.clone().addScaledVector(dir, -d)) - sole > 0.05) d += 0.005;
            worst = Math.max(worst, d);
          }
        },
      });
      assert.ok(top > rise * (COUNT - 1), 'no recorrió la escalera');
      assert.ok(worst < 0.01, `la punta entró ${(worst * 100).toFixed(1)} cm en una contrahuella`);
    });
  }

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
