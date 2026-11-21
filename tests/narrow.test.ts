import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import { defaultConfig } from '../src/index.ts';
import { createWorld, SIDES, simulate, type World, type WorldOptions } from './helpers/sim.ts';

/** Caja de w × h × d con la base en el suelo, centrada en (x, z). */
function block(parent: Object3D, w: number, h: number, d: number, x: number, z: number): void {
  const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  mesh.position.set(x, h / 2, z);
  parent.add(mesh);
}

/**
 * Brazos abiertos haciendo equilibrio: la mano, a más de ARM_OUT del cuerpo hacia el lado (m); caminando normal (o
 * con la otra mano apoyada), a menos de ARM_IN.
 */
const ARM_OUT = 0.48;
const ARM_IN = 0.36;
const BEAM_HEIGHT = 0.4;
const BEAM_WIDTH = 0.2;

/** El personaje (que mira hacia −Z) de pie en z = 0 sobre lo que construya `build`, a `height`. */
function worldOn(build: (terrain: Object3D) => void, height = BEAM_HEIGHT, options: WorldOptions = {}): World {
  const world = createWorld({ ...options, buildTerrain: build });
  world.model.position.set(0, height, 0);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

/** Viga de 20 cm a lo largo de −Z, centrada en x = `x`, de z = 1 a z = −9. */
const beam = (x = 0) => (terrain: Object3D): void => block(terrain, BEAM_WIDTH, BEAM_HEIGHT, 10, x, -4);

const ankle = (world: World, side: 'left' | 'right'): Vector3 => world.human.rig[side].foot.getWorldPosition(new Vector3());

describe('caminos angostos', () => {
  it('sobre una viga de 20 cm hace equilibrio: más despacio, pies en línea por el medio, sin chocar', () => {
    const world = worldOn(beam());
    const { human } = world;
    const loco = human.locomotion;
    let minBalance = 1;
    let maxSpeed = 0;
    let maxOff = 0;
    let maxWidth = 0;
    let minApart = Infinity;
    const r = simulate(world, 7, [[0, (h) => { h.targetSpeed = 1.4; }]], {
      onFrame: (t) => {
        if (t < 1.5) return;
        minBalance = Math.min(minBalance, human.balance);
        maxSpeed = Math.max(maxSpeed, human.speed);
        // Arrancando desde parado, los primeros pasos aún van a la anchura de parado.
        if (t < 3) return;
        const l = ankle(world, 'left');
        const rr = ankle(world, 'right');
        for (const side of SIDES) {
          if (human.footPhase(side) === 'SWING') continue;
          maxOff = Math.max(maxOff, Math.abs(loco.feet[side].planted.x));
        }
        if (human.footPhase('left') !== 'SWING' && human.footPhase('right') !== 'SWING') {
          maxWidth = Math.max(maxWidth, Math.abs(loco.feet.left.planted.x - loco.feet.right.planted.x));
        }
        // Al pasar un tobillo junto al otro, no se atraviesan.
        if (Math.abs(l.z - rr.z) < 0.05) minApart = Math.min(minApart, Math.hypot(l.x - rr.x, l.y - rr.y));
      },
    });
    assert.ok(minBalance > 0.99, `equilibrio ${minBalance.toFixed(2)}`);
    assert.ok(maxSpeed <= defaultConfig.narrowMaxSpeed + 1e-6, `velocidad ${maxSpeed.toFixed(2)} m/s`);
    assert.ok(maxOff < 0.03, `un pie apoyado a ${(maxOff * 100).toFixed(1)} cm del medio de la viga`);
    assert.ok(maxWidth < defaultConfig.narrowStepWidth + 0.02, `pies a ${(maxWidth * 100).toFixed(1)} cm de lado`);
    assert.ok(minApart > 0.06, `los tobillos pasan a ${(minApart * 100).toFixed(1)} cm`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.alternates, `slip ${r.slip}, IK ${r.stanceIK}, ${r.liftoffs}`);
    assert.ok(r.finiteOK);
  });

  it('con los brazos abiertos, y al bajar de la viga vuelve a caminar normal', () => {
    // Viga de z = 1 a −3, y después suelo ancho a la misma altura.
    const world = worldOn((terrain) => {
      block(terrain, BEAM_WIDTH, BEAM_HEIGHT, 4, 0, -1);
      block(terrain, 3, BEAM_HEIGHT, 6, 0, -6);
    });
    const { human } = world;
    const arm = human.rig.leftArm!;
    // Lo que se separa la mano del cuerpo hacia el lado (m; camina a lo largo de Z).
    const handOut = (): number => Math.abs(arm.hand.getWorldPosition(new Vector3()).x - human.position.x);
    let onBeam = Infinity;
    let leftBeam = -Infinity;
    let afterBalance = 1;
    simulate(world, 8, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: () => {
        const z = human.position.z;
        if (z < -1.5 && z > -2.5) onBeam = Math.min(onBeam, handOut());
        if (z < -4.5) {
          afterBalance = Math.min(afterBalance, 1 - human.balance);
          leftBeam = Math.max(leftBeam, handOut());
        }
      },
    });
    assert.ok(human.position.z < -5, `no llegó al final (z = ${human.position.z.toFixed(2)})`);
    assert.ok(onBeam > ARM_OUT, `sobre la viga, la mano solo a ${(onBeam * 100).toFixed(0)} cm del cuerpo`);
    assert.ok(afterBalance > 0.99, 'siguió haciendo equilibrio en el suelo ancho');
    assert.ok(leftBeam < ARM_IN, `en el suelo ancho, la mano a ${(leftBeam * 100).toFixed(0)} cm del cuerpo`);
  });

  it('sigue hasta el final de la viga: no deja el equilibrio al verlo por delante', () => {
    const world = worldOn((terrain) => {
      block(terrain, BEAM_WIDTH, BEAM_HEIGHT, 4, 0, -1);
      block(terrain, 3, BEAM_HEIGHT, 6, 0, -6);
    });
    const { human } = world;
    let minBalance = 1;
    simulate(world, 6, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: () => {
        const z = human.position.z;
        if (z < -1 && z > -3 + 0.15) minBalance = Math.min(minBalance, human.balance);
      },
    });
    assert.ok(minBalance > 0.99, `equilibrio ${minBalance.toFixed(2)} antes de acabar la viga`);
  });

  for (const kind of ['baranda', 'pared'] as const) {
    it(`junto a una ${kind}, apoya la mano en ella y el otro brazo baja casi a la pose normal`, () => {
      const world = worldOn(beam());
      const { human } = world;
      // A la derecha de la viga, desde z = −3: una baranda a 1 m sobre ella o una pared.
      const surface = new Mesh(kind === 'pared' ? new BoxGeometry(0.2, 2.5, 6) : new BoxGeometry(0.08, 0.06, 6), new MeshBasicMaterial());
      surface.position.set(kind === 'pared' ? 0.55 : 0.45, kind === 'pared' ? 1.25 : 1.4, -6);
      world.scene.add(surface);
      surface.updateMatrixWorld(true);
      human.touchables = [surface];
      const touches: string[] = [];
      human.on('touch', ({ side }) => touches.push(side));
      const left = human.rig.leftArm!;
      // Lo que se separa la mano izquierda del cuerpo hacia el lado (m): antes de tocar (abierta) y con la derecha
      // apoyada del todo (casi como al caminar).
      const leftHand = (): number => Math.abs(left.hand.getWorldPosition(new Vector3()).x - human.position.x);
      let before = Infinity;
      let touching = -Infinity;
      let minBalance = 1;
      let maxOff = 0;
      const r = simulate(world, 9, [[0, (h) => { h.targetSpeed = 0.8; }]], {
        onFrame: (t) => {
          if (t < 1.5) return;
          minBalance = Math.min(minBalance, human.balance);
          maxOff = Math.max(maxOff, Math.abs(human.position.x));
          const weight = human.locomotion.touch.weight('right');
          if (weight === 0 && human.position.z > -1.5) before = Math.min(before, leftHand());
          if (weight > 0.99) touching = Math.max(touching, leftHand());
        },
      });
      assert.deepEqual([...new Set(touches)], ['right'], `toques: ${touches.join(',') || 'ninguno'}`);
      assert.ok(minBalance > 0.99, `equilibrio ${minBalance.toFixed(2)}`);
      assert.ok(before > ARM_OUT, `antes de tocar, la mano izquierda solo a ${(before * 100).toFixed(0)} cm del cuerpo`);
      assert.ok(touching < ARM_IN, `tocando, la mano izquierda a ${(touching * 100).toFixed(0)} cm del cuerpo`);
      assert.ok(maxOff < 0.02, `el cuerpo se apartó ${(maxOff * 100).toFixed(1)} cm del medio`);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.finiteOK);
    });
  }

  it('desviado del medio, vuelve a él; parado, los pies no se superponen', () => {
    const world = worldOn(beam(0.06));
    const { human } = world;
    const r = simulate(world, 6, [[0, (h) => { h.targetSpeed = 1; }], [4, (h) => { h.targetSpeed = 0; }]]);
    assert.ok(Math.abs(human.position.x - 0.06) < 0.01, `cuerpo en x = ${human.position.x.toFixed(3)}`);
    assert.equal(human.gaitMode, 'idle');
    assert.ok(human.balance > 0.99);
    const l = ankle(world, 'left');
    const rr = ankle(world, 'right');
    const apart = Math.abs(l.x - rr.x);
    assert.ok(apart > 0.08, `parado, pies a ${(apart * 100).toFixed(1)} cm de lado`);
    for (const p of [l, rr]) assert.ok(Math.abs(p.x - 0.06) < 0.07, `un pie en x = ${p.x.toFixed(3)} (viga en 0,06)`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('en suelo ancho, junto a un borde o con narrowWidth 0, no hace equilibrio', () => {
    // Suelo plano.
    const flat = createWorld();
    let max = 0;
    simulate(flat, 4, [[0, (h) => { h.targetSpeed = 1.4; }]], { onFrame: () => { max = Math.max(max, flat.human.balance); } });
    assert.equal(max, 0, 'en el suelo plano');
    // Por el borde de una plataforma de 2 m (el pie de fuera a ~15 cm del borde).
    const edge = worldOn((terrain) => block(terrain, 2, BEAM_HEIGHT, 12, -0.85, -4));
    simulate(edge, 4, [[0, (h) => { h.targetSpeed = 1.4; }]], { onFrame: () => { max = Math.max(max, edge.human.balance); } });
    assert.equal(max, 0, 'junto al borde de una plataforma');
    // Viga con narrowWidth 0.
    const off = worldOn(beam(), BEAM_HEIGHT, { human: { config: { narrowWidth: 0 } } });
    simulate(off, 3, [[0, (h) => { h.targetSpeed = 1; }]], { onFrame: () => { max = Math.max(max, off.human.balance); } });
    assert.equal(max, 0, 'con narrowWidth 0');
  });

  // Antes, en la entrada del muro se paraba: el borde recordado de su costado (a 6 cm del cuerpo, menos que la holgura
  // de los pies) frenaba con el rumbo torcido 2°; parado, volvía a planear la ruta y daba media vuelta.
  for (const [x, z, scale] of [[4.4, -0.6, 0.896], [3.4, -1.7, 1], [6, -1.6, 1]] as const) {
    it(`moveTo desde la plataforma (${x}, ${z}, escala ${scale}) entra en el muro sin pararse`, () => {
      const world = worldOn((terrain) => {
        block(terrain, 3.5, 1.02, 6, 4.75, 1);
        block(terrain, 0.25, 1.02, 3.6, 4.75, -3.8);
        block(terrain, 1.4, 1.02, 1.4, 4.75, -6.3);
      }, 0, { modelScale: scale });
      const { human } = world;
      world.model.position.set(x, 1.02, z);
      world.model.updateMatrixWorld(true);
      human.reset();
      const pedestal = new Vector3(4.75, 1.02, -6.3);
      human.moveTo(pedestal);
      // Paradas desde que se aleja del punto de partida (no el giro del arranque).
      const start = human.position.clone();
      let away = false;
      let stopped = 0;
      let longest = 0;
      simulate(world, 16, [], {
        onFrame: () => {
          away ||= human.position.distanceTo(start) > 0.5;
          const arriving = human.position.distanceTo(pedestal) < 0.5;
          stopped = away && !arriving && human.moveTarget && human.speed < 0.05 ? stopped + 1 / 60 : 0;
          longest = Math.max(longest, stopped);
        },
      });
      assert.ok(human.position.distanceTo(pedestal) < 0.15, `no llegó: ${human.position.toArray().map((v) => v.toFixed(2))}`);
      assert.ok(longest < 0.2, `se paró ${longest.toFixed(2)} s por el camino`);
    });
  }

  it('moveTo traza la ruta por un camino angosto si no hay otra: al pedestal por el muro, y de vuelta', () => {
    // Plataforma de 1,02 m con escalera en su cara +X; de su borde −Z sale un muro de 25 cm hasta un pedestal.
    const world = worldOn((terrain) => {
      block(terrain, 3.5, 1.02, 6, 4.75, 1);
      for (let k = 1; k < 6; k++) block(terrain, 0.28, 0.17 * k, 1.4, 6.5 + 0.28 * (5.5 - k), 2.6);
      block(terrain, 0.25, 1.02, 3.6, 4.75, -3.8);
      block(terrain, 1.4, 1.02, 1.4, 4.75, -6.3);
    }, 0);
    const { human } = world;
    world.model.position.set(5.6, 0, -3);
    world.model.updateMatrixWorld(true);
    human.reset();
    const pedestal = new Vector3(4.75, 1.02, -6.3);
    human.moveTo(pedestal);
    let maxOff = 0;
    let balanced = 0;
    const track = (): void => {
      const p = human.position;
      if (p.y > 0.9 && p.z < -2.2 && p.z > -5.4) {
        maxOff = Math.max(maxOff, Math.abs(p.x - 4.75));
        balanced = Math.max(balanced, human.balance);
      }
    };
    const there = simulate(world, 30, [], { onFrame: track });
    const at = (): string => human.position.toArray().map((v) => v.toFixed(2)).join(', ');
    assert.ok(human.position.distanceTo(pedestal) < 0.15, `no llegó al pedestal: ${at()}`);
    assert.ok(balanced > 0.99, 'no hizo equilibrio en el muro');
    // De vuelta a la plataforma: el único camino es el muro.
    const back = new Vector3(4.75, 1.02, 0);
    human.moveTo(back);
    const again = simulate(world, 15, [], { onFrame: track, start: 30 });
    assert.ok(human.position.distanceTo(back) < 0.15, `no volvió: ${at()}`);
    assert.ok(maxOff < 0.06, `se apartó ${(maxOff * 100).toFixed(1)} cm del medio del muro`);
    for (const r of [there, again]) assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.finiteOK);
  });

  it('moveTo no usa un camino angosto si puede rodearlo', () => {
    // Viga alta (1 m) de 25 cm entre dos plataformas de 5 m, que también se unen por un puente de 1,2 m a 2 m de ella.
    const world = worldOn((terrain) => {
      block(terrain, 5, 1, 2, -1, 1);
      block(terrain, 5, 1, 2, -1, -5);
      block(terrain, 0.25, 1, 4, 0, -2);
      block(terrain, 1.2, 1, 4, -2.2, -2);
    }, 1);
    const { human } = world;
    human.moveTo(new Vector3(0, 1, -5.5));
    const path = human.movePath ?? [];
    const route = path.map((p) => p.toArray().map((v) => v.toFixed(1)).join(',')).join(' | ');
    const onBeam = path.some((p) => Math.abs(p.x) < 0.3 && p.z < -0.5 && p.z > -3.5);
    assert.ok(path.length > 1 && !onBeam, `ruta: ${route || 'en línea recta'}`);
  });

  // Viga baja (30 cm, se puede pisar desde el suelo) detrás y a la derecha del personaje, de z = 1 a 7.
  const lowBeam = (terrain: Object3D): void => block(terrain, BEAM_WIDTH, 0.3, 6, 2, 4);

  for (const z of [1.6, 4, 6.5]) {
    it(`clic en una viga baja (z = ${z}): sube por un extremo, en línea, y se para con los dos pies en ella`, () => {
      const world = createWorld({ buildTerrain: lowBeam });
      const { human } = world;
      const loco = human.locomotion;
      const target = new Vector3(2, 0.3, z);
      human.moveTo(target);
      // Desde que pisa la viga con los dos pies, ningún pie vuelve al suelo (antes subía de lado y no se aclaraba).
      let both = false;
      let backDown = 0;
      const r = simulate(world, 18, [], {
        onFrame: () => {
          const up = SIDES.map((side) => human.footPhase(side) !== 'SWING' && loco.feet[side].planted.y > 0.2);
          if (up[0] && up[1]) both = true;
          for (const side of SIDES) if (both && human.footPhase(side) !== 'SWING' && loco.feet[side].planted.y < 0.2) backDown++;
        },
      });
      assert.equal(human.moveTarget, null, 'no llegó');
      assert.ok(human.position.distanceTo(target) < 0.15, `se paró en ${human.position.toArray().map((v) => v.toFixed(2))}`);
      assert.equal(backDown, 0, 'un pie volvió a bajar al suelo');
      for (const side of SIDES) {
        const p = loco.feet[side].planted;
        assert.ok(p.y > 0.2 && Math.abs(p.x - 2) < 0.07, `pie ${side} en ${p.toArray().map((v) => v.toFixed(2))}`);
      }
      assert.ok(human.balance > 0.99);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.finiteOK);
    });
  }

  for (const target of [new Vector3(4, 0, 4), new Vector3(4, 0, 6)]) {
    it(`moveTo al otro lado de una viga baja (${target.x}, ${target.z}): la cruza por encima, no la rodea`, () => {
      const world = createWorld({ buildTerrain: lowBeam });
      const { human } = world;
      human.moveTo(target);
      // Por dónde cruza la línea de la viga (x = 2): entre sus extremos (z de 1 a 7), no rodeándola.
      let crossed = Number.NaN;
      let previousX = human.position.x;
      let stopped = 0;
      let longest = 0;
      const r = simulate(world, 14, [], {
        onFrame: (t) => {
          const p = human.position;
          if (previousX < 2 && p.x >= 2) crossed = p.z;
          previousX = p.x;
          stopped = t > 1.5 && human.moveTarget && human.speed < 0.05 && p.distanceTo(target) > 0.5 ? stopped + 1 / 60 : 0;
          longest = Math.max(longest, stopped);
        },
      });
      assert.ok(crossed > 1.2 && crossed < 6.8, `cruzó la línea de la viga en z = ${crossed.toFixed(2)}`);
      assert.ok(human.position.distanceTo(target) < 0.15, `no llegó: ${human.position.toArray().map((v) => v.toFixed(2))}`);
      assert.ok(longest < 0.3, `se paró ${longest.toFixed(2)} s`);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.finiteOK);
    });
  }

  it('subiendo a una viga desde el suelo, hace equilibrio desde el primer paso en ella', () => {
    // La viga empieza en z = −1, delante del personaje (que mira hacia −Z).
    const world = createWorld({ buildTerrain: (terrain) => block(terrain, BEAM_WIDTH, 0.3, 6, 0, -4) });
    const { human } = world;
    const loco = human.locomotion;
    let maxOff = 0;
    simulate(world, 6, [[0, (h) => { h.targetSpeed = 1; }]], {
      onFrame: () => {
        // Pasado el segundo paso sobre la viga (el primero ya en equilibrio, por delante).
        if (human.position.z > -1.8) return;
        for (const side of SIDES) if (human.footPhase(side) !== 'SWING') maxOff = Math.max(maxOff, Math.abs(loco.feet[side].planted.x));
      },
    });
    assert.ok(human.position.z < -3, 'no avanzó por la viga');
    assert.ok(maxOff < 0.04, `un pie apoyado a ${(maxOff * 100).toFixed(1)} cm del medio`);
  });
});
