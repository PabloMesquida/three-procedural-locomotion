import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

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

  for (const [name, width, config] of [['más ancho que maxGapJump', 1.2, {}], ['con maxGapStep y maxGapJump 0', 0.3, { maxGapStep: 0, maxGapJump: 0 }], ['de 80 cm con maxGapJump 0', 0.8, { maxGapJump: 0 }]] as const) {
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

  for (const [width, speed, start] of [[0.65, 1.4, 10], [1, 1.4, 10], [0.9, 3, 10], [1, 5, 10]] as const) {
    it(`salta un hueco de ${width * 100} cm a ${speed} m/s sin pararse, de un pie a otro, y cae pasada la otra orilla`, () => {
      const world = gapWorld(width, start);
      const { human } = world;
      let liftoffs = 0;
      // Al caer, lo que el pie de delante adelanta al otro (de un pie a otro, no con los dos a la par).
      let split = 0;
      human.on('liftoff', () => { liftoffs++; });
      human.on('land', () => {
        const f = human.locomotion.body.state.forward;
        const d = human.rig.right.foot.getWorldPosition(new Vector3()).sub(human.rig.left.foot.getWorldPosition(new Vector3()));
        split = Math.abs(d.x * f.x + d.z * f.z);
      });
      const r = cross(world, width, start > 5 ? 9 + 10 / speed : 8, (h) => {
        h.targetHeading = 0;
        h.targetSpeed = speed;
      });
      assert.equal(liftoffs, 1, `saltó ${liftoffs} veces`);
      assert.ok(split > 0.3, `cayó con los pies a ${(split * 100).toFixed(0)} cm uno del otro`);
      assert.ok(human.position.z < -width - 0.5 && human.position.y > H - 0.01, `no cruzó: (${human.position.z.toFixed(2)}, ${human.position.y.toFixed(2)})`);
      assert.ok(r.lowest > H - 0.01, `la raíz bajó a ${r.lowest.toFixed(2)} m`);
      assert.equal(r.inGap, 0, 'un pie apoyado en el hueco');
      assert.ok(r.ik < 0.03, `la IK no llegó por ${(r.ik * 100).toFixed(1)} cm`);
      assert.ok(r.hips > 0.7, `las caderas bajaron a ${r.hips.toFixed(2)} piernas`);
    });
  }

  it('casi parado (0,3 m/s), se para en el borde de un hueco de 90 cm y lo salta con los dos pies (CMU: saltos hacia delante sin carrera)', () => {
    const world = gapWorld(0.9, 3);
    const { human } = world;
    let split = Infinity;
    let liftoffSpeed = Infinity;
    human.on('liftoff', () => { liftoffSpeed = Math.min(liftoffSpeed, human.locomotion.body.state.speed); });
    human.on('land', () => {
      const f = human.locomotion.body.state.forward;
      const d = human.rig.right.foot.getWorldPosition(new Vector3()).sub(human.rig.left.foot.getWorldPosition(new Vector3()));
      split = Math.abs(d.x * f.x + d.z * f.z);
    });
    const r = cross(world, 0.9, 16, (h) => { h.targetHeading = 0; h.targetSpeed = 0.3; });
    assert.ok(human.position.z < -1.4 && human.position.y > H - 0.01, `no cruzó: (${human.position.z.toFixed(2)}, ${human.position.y.toFixed(2)})`);
    assert.ok(split < 0.1, `cayó con los pies a ${(split * 100).toFixed(0)} cm uno del otro`);
    assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco o pisó en él');
    assert.ok(r.ik < 0.03, `la IK no llegó por ${(r.ik * 100).toFixed(1)} cm`);
  });

  it('moveTo al otro lado de un hueco de 90 cm: salta y llega', () => {
    const world = gapWorld(0.9);
    const { human } = world;
    let arrived = false;
    human.on('arrive', () => { arrived = true; });
    const goal = new Vector3(1.5, H, -2.5);
    const r = cross(world, 0.9, 12, (h) => h.moveTo(goal));
    assert.ok(arrived && human.position.distanceTo(goal) < 0.3, `no llegó: (${human.position.x.toFixed(2)}, ${human.position.z.toFixed(2)})`);
    assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco o pisó en él');
  });

  it('moveTo al otro lado de un hueco más ancho que maxGapJump: no lo cruza, se queda en el borde más cercano', () => {
    const world = gapWorld(1.2);
    const { human } = world;
    const r = cross(world, 1.2, 8, (h) => h.moveTo(new Vector3(0, H, -3)));
    assert.ok(human.position.z > 0 && r.lowest > H - 0.01, `cruzó o cayó: (${human.position.z.toFixed(2)}, ${human.position.y.toFixed(2)})`);
    assert.ok(human.position.z < 0.6, `no se acercó al borde (z ${human.position.z.toFixed(2)})`);
  });
});

describe('huecos con carrera (maxGapJumpRun)', () => {
  /** Pies al despegar y al caer del primer salto: el que despega (apoyado) y el que cae primero. */
  const feet = (world: World) => {
    const { human } = world;
    const seen = { takeoff: '', landing: '' };
    human.on('liftoff', () => { seen.takeoff ||= SIDES.find((s) => human.footPhase(s) !== 'SWING') ?? ''; });
    human.on('land', () => { seen.landing ||= SIDES.find((s) => human.footPhase(s) !== 'SWING') ?? ''; });
    return seen;
  };

  for (const speed of [3, 5]) {
    it(`a ${speed} m/s salta un hueco de 1,3 m (más ancho que maxGapJump)${speed < 4 ? ' dando un paso en el aire: cae con el pie con el que despegó' : ''}`, () => {
      const world = gapWorld(1.3, 10);
      const seen = feet(world);
      const r = cross(world, 1.3, 9, (h) => { h.targetHeading = 0; h.targetSpeed = speed; });
      assert.ok(world.human.position.z < -1.3 - 0.5, `no cruzó (z ${world.human.position.z.toFixed(2)})`);
      assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco o pisó en él');
      // A 5 m/s el vuelo es corto (< AIR_STEP_FLIGHT): sin paso en el aire.
      if (speed < 4) assert.ok(seen.takeoff !== '' && seen.takeoff === seen.landing, `despegó con ${seen.takeoff} y cayó con ${seen.landing} (sin paso en el aire, con el otro)`);
    });
  }

  it('caminando, ante el mismo hueco se para en el borde (solo lo salta con carrera)', () => {
    const world = gapWorld(1.3, 10);
    const r = cross(world, 1.3, 12, (h) => { h.targetHeading = 0; h.targetSpeed = 1.4; });
    assert.ok(world.human.position.z > 0 && r.lowest > H - 0.01, `cruzó o cayó (z ${world.human.position.z.toFixed(2)})`);
  });

  it('caminando, un salto de un pie a otro no da el paso en el aire: cae con el libre', () => {
    const world = gapWorld(0.8, 10);
    const seen = feet(world);
    cross(world, 0.8, 10, (h) => { h.targetHeading = 0; h.targetSpeed = 1.4; });
    assert.ok(seen.takeoff !== '' && seen.landing !== '' && seen.takeoff !== seen.landing, `despegó con ${seen.takeoff} y cayó con ${seen.landing}`);
  });

  it('moveTo al otro lado de uno de 1,3 m: con run lo salta y llega; sin run, se queda en el borde', () => {
    const goal = new Vector3(0, H, -3.5);
    const running = gapWorld(1.3, 10);
    let arrived = false;
    running.human.on('arrive', () => { arrived = true; });
    const r = cross(running, 1.3, 12, (h) => h.moveTo(goal, { run: true }));
    assert.ok(arrived && running.human.position.distanceTo(goal) < 0.3, `corriendo no llegó: (${running.human.position.x.toFixed(2)}, ${running.human.position.z.toFixed(2)})`);
    assert.ok(r.lowest > H - 0.01 && r.inGap === 0, 'cayó en el hueco o pisó en él');
    const walking = gapWorld(1.3, 10);
    cross(walking, 1.3, 14, (h) => h.moveTo(goal));
    assert.ok(walking.human.position.z > 0, `caminando cruzó (z ${walking.human.position.z.toFixed(2)})`);
  });

  it('con maxGapJumpRun igual a maxGapJump, corriendo tampoco lo salta', () => {
    const world = gapWorld(1.3, 10, { maxGapJumpRun: 1 });
    const r = cross(world, 1.3, 9, (h) => { h.targetHeading = 0; h.targetSpeed = 3; });
    assert.ok(world.human.position.z > 0 && r.lowest > H - 0.01, `cruzó o cayó (z ${world.human.position.z.toFixed(2)})`);
  });
});

// Una zanja entre dos tarimas, menos honda que maxStepDown (podría bajar a ella): como una grieta entre dos rocas, la
// cruza de un paso como un hueco, sin pisarla. Antes pisaba en ella (las de 25 a 45 cm), con la raíz bajando con el pie;
// y sobre una angosta que cruzaba de un paso normal (15 cm), la raíz bajaba igual (hasta 21 cm).
describe('zanjas que podría bajar (maxGapStep)', () => {
  for (const [width, depth, speed] of [[0.25, 0.15, 0.6], [0.35, 0.25, 1.4], [0.45, 0.15, 1.4], [0.45, 0.3, 0.6], [0.15, 0.3, 1.4]] as const) {
    it(`una zanja de ${width * 100} cm de ancho y ${depth * 100} cm de hondo a ${speed} m/s: la cruza sin pisarla ni bajar la raíz`, () => {
      const world = createWorld({
        buildTerrain: (g) => {
          box(g, 6, H, 12, 0, 0, 6);
          box(g, 6, H, 6, 0, 0, -width - 3);
          box(g, 6, H - depth, width, 0, 0, -width / 2);
        },
      });
      world.model.position.set(0, H, 1.6);
      world.model.updateMatrixWorld(true);
      world.human.reset();
      const r = cross(world, width, 8, (h) => { h.targetHeading = 0; h.targetSpeed = speed; });
      const { human } = world;
      assert.ok(human.position.z < -width - 0.5, `no cruzó: z ${human.position.z.toFixed(2)}`);
      assert.equal(r.inGap, 0, 'un pie apoyado en la zanja');
      assert.ok(r.lowest > H - 0.04, `la raíz bajó a ${r.lowest.toFixed(2)} m`);
    });
  }
});

// Una grieta como las de entre dos rocas: de este lado una cara que baja en rampa (43°, más que maxSlope), del otro una
// pared más alta que maxStepUp. El perfil no la ve como hondonada (una cara inclinada no es un borde) y la ruta no veía
// cómo cruzarla: la rodeaba o bajaba a ella. Ahora moveTo la cruza de frente, como un hueco, y los pasos por encima.
// También con una ranura más honda que maxStepDown junto a la pared (60 cm, como en la isla del diorama): desde la pared, el
// primer suelo que se puede pisar pasada la ranura es la rampa, dentro de la grieta; y la raíz, con un pie a cada lado,
// bajaba a ella.
describe('grieta con una cara en rampa (maxGapStep)', () => {
  for (const [speed, back, depth] of [[1.4, false, false], [1.4, true, false], [0.6, false, false], [0.6, true, false], [1.4, false, true], [1.4, true, true], [0.6, true, true]] as const) {
    it(`moveTo al otro lado a ${speed} m/s${back ? ', desde el lado de la pared' : ''}${depth ? ', con una ranura honda junto a ella' : ''}: la cruza sin pisarla ni bajar la raíz a ella`, () => {
      const world = createWorld({
        buildTerrain: (g) => {
          box(g, 6, H, 12, 0, 0, 6);
          box(g, 6, H, 6, 0, 0, -0.45 - 3);
          if (depth) {
            box(g, 6, H - 0.35, 0.33, 0, 0, -0.165);
            box(g, 6, H - 0.6, 0.12, 0, 0, -0.39);
          } else box(g, 6, H - 0.4, 0.45, 0, 0, -0.225);
          const theta = Math.atan2(0.35, 0.37);
          const ramp = new Mesh(new BoxGeometry(6, 0.3, Math.hypot(0.35, 0.37)), new MeshBasicMaterial());
          ramp.rotation.x = -theta;
          ramp.position.set(0, H - 0.175 - 0.15 * Math.cos(theta), -0.185 + 0.15 * Math.sin(theta));
          g.add(ramp);
        },
        human: { config: { walkSpeed: speed } },
      });
      const from = back ? -2 : 1.6;
      const to = back ? 1.6 : -2;
      world.model.position.set(0, H, from);
      world.model.rotation.set(0, back ? 0 : Math.PI, 0);
      world.model.updateMatrixWorld(true);
      world.human.reset();
      const { human } = world;
      const loco = human.locomotion;
      let inCrack = 0;
      let lowest = Infinity;
      const was: Record<Side, boolean> = { left: false, right: false };
      simulate(world, 9, [[0, (h) => h.moveTo(new Vector3(0, H, to))]], {
        onFrame: () => {
          lowest = Math.min(lowest, human.position.y);
          for (const side of SIDES) {
            const air = human.footPhase(side) === 'SWING';
            if (was[side] && !air && loco.feet[side].planted.y - loco.planner.placement(side).ankleHeight < H - 0.12) inCrack++;
            was[side] = air;
          }
        },
      });
      assert.ok(Math.abs(human.position.z - to) < 0.3, `no llegó: z ${human.position.z.toFixed(2)}`);
      assert.equal(inCrack, 0, 'un pie apoyado en la grieta');
      assert.ok(lowest > H - 0.18, `la raíz bajó a ${lowest.toFixed(2)} m`);
    });
  }
});

// Una zanja como las de arriba, más honda que maxStepDown (60 cm) y en diagonal a la cuadrícula de la ruta (girada 30°
// o 60°). La ruta solo enlazaba por encima de una hondonada en 8 direcciones, y el atajo en línea recta no la cruzaba:
// para cruzarla en una de ellas, volvía atrás y la rodeaba en parte; en una grieta de la isla del diorama, unos 8 s de
// pasos de giro, y uno en ella.
describe('zanja en diagonal a la cuadrícula (maxGapStep)', () => {
  for (const angle of [30, 60]) {
    it(`girada ${angle}°: moveTo la cruza en línea recta, sin pisarla`, () => {
      const a = (angle * Math.PI) / 180;
      const world = createWorld({
        buildTerrain: (g) => {
          const group = new Group();
          group.rotation.y = a;
          box(group, 8, H, 6, 0, 0, 3);
          box(group, 8, H, 6, 0, 0, -0.35 - 3);
          box(group, 8, H - 0.6, 0.35, 0, 0, -0.175);
          g.add(group);
        },
      });
      // A lo largo de la normal de la zanja (−z girada), de 2,4 m de este lado (empieza mirando hacia −z: así, antes de
      // llegar a ella, ya gira hacia ella) a 1,2 m del otro.
      const nx = -Math.sin(a);
      const nz = -Math.cos(a);
      const from = new Vector3(-nx * 2.4, H, -nz * 2.4);
      const to = new Vector3(nx * 1.55, H, nz * 1.55);
      world.model.position.copy(from);
      world.model.updateMatrixWorld(true);
      world.human.reset();
      const { human } = world;
      const loco = human.locomotion;
      let route: Vector3[] | null = null;
      let inTrench = 0;
      let arrived = Number.NaN;
      const was: Record<Side, boolean> = { left: false, right: false };
      simulate(world, 8, [[0, (h) => { h.moveTo(to); route = h.movePath; }]], {
        onFrame: (t) => {
          for (const side of SIDES) {
            const air = human.footPhase(side) === 'SWING';
            if (was[side] && !air && loco.feet[side].planted.y - loco.planner.placement(side).ankleHeight < H - 0.1) inTrench++;
            was[side] = air;
          }
          const p = human.position;
          if (Number.isNaN(arrived) && Math.hypot(p.x - to.x, p.z - to.z) < 0.2) arrived = t;
        },
      });
      // En línea recta: sin ruta (movePath null) o con un solo punto, el destino.
      const points = (route as Vector3[] | null) ?? [];
      assert.ok(points.length <= 1, `ruta de ${points.length} puntos: ${points.map((p) => `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`).join(' ')}`);
      assert.ok(arrived < 5, `llegó a los ${arrived.toFixed(1)} s`);
      assert.equal(inTrench, 0, 'un pie apoyado en la zanja');
    });
  }
});
