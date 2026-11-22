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

  // Antes, en una viga baja (se baja de un paso a los lados), girando en ella la escalera veía en sus costados escalones
  // y la raíz bajaba por la línea entre la viga y el suelo: hasta 22 cm más abajo, con las rodillas dobladas.
  it('en una viga baja, después de girar en ella, la raíz sigue a su altura', () => {
    const low = 0.3;
    const world = worldOn((terrain) => block(terrain, BEAM_WIDTH, low, 10, 0, -4), low);
    const { human } = world;
    let lowest = Number.POSITIVE_INFINITY;
    simulate(world, 10, [[0, (h) => { h.targetHeading = Math.PI; }], [3, (h) => { h.targetHeading = 0; }], [6, (h) => { h.targetSpeed = 0.6; }]], {
      onFrame: () => { lowest = Math.min(lowest, human.position.y); },
    });
    assert.ok(human.position.z < -1.5, 'no avanzó por la viga');
    assert.ok(lowest > low - 0.01, `la raíz bajó a ${lowest.toFixed(3)} m (la viga, a ${low})`);
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

  /** Plataforma, muro de 25 cm y pedestal a 1,02 m; el personaje (escala `scale`) de pie en el medio del muro. */
  const onWall = (scale: number): World => {
    const world = createWorld({
      modelScale: scale,
      buildTerrain: (terrain) => {
        block(terrain, 3.5, 1.02, 6, 4.75, 1);
        block(terrain, 0.25, 1.02, 3.6, 4.75, -3.8);
        block(terrain, 1.4, 1.02, 1.4, 4.75, -6.3);
      },
    });
    world.model.position.set(4.75, 1.02, -3.2);
    world.model.updateMatrixWorld(true);
    world.human.reset();
    return world;
  };

  // Antes, girando sobre el muro (mirando a su costado) dejaba de verlo como camino angosto: sin equilibrio, la escalera
  // veía en él un escalón y cada paso subía la rodilla al máximo (31–35 cm); y frente al borde no llegaba a pararse y
  // daba pasos en el sitio hasta caerse.
  for (const scale of [0.896, 1]) {
    it(`sobre el muro, media vuelta en el sitio (escala ${scale}): pasos normales y sin dejar el equilibrio`, () => {
      const world = onWall(scale);
      const { human } = world;
      const loco = human.locomotion;
      let highest = 0;
      let minBalance = 1;
      let fell = false;
      let prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
      simulate(world, 8, [[0, (h) => { h.targetHeading = Math.PI; }], [3, (h) => { h.targetSpeed = 0.6; }]], {
        onFrame: (t) => {
          const p = human.position;
          if (p.y < 0.9) fell = true;
          if (p.z < -2.3 && p.z > -5.3 && t > 1) minBalance = Math.min(minBalance, human.balance);
          for (const side of SIDES) {
            const f = loco.feet[side];
            if (prev[side] !== 'SWING' && f.phase === 'SWING' && p.z < -2.3) highest = Math.max(highest, f.swing.height);
          }
          prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
        },
      });
      assert.ok(!fell, 'se cayó del muro');
      assert.ok(highest < 0.1, `un paso subió ${(highest * 100).toFixed(0)} cm`);
      assert.ok(minBalance > 0.9, `dejó el equilibrio (${minBalance.toFixed(2)}) sobre el muro`);
      assert.ok(human.position.z > -1, 'no volvió a la plataforma');
    });

    for (const degrees of [30, 90]) {
      it(`sobre el muro, caminando con el rumbo ${degrees}° hacia el costado (escala ${scale}): se para en el borde y no se cae`, () => {
        const world = onWall(scale);
        const { human } = world;
        const loco = human.locomotion;
        let fell = false;
        let late = 0;
        let highest = 0;
        let prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
        simulate(world, 9, [[0, (h) => { h.targetSpeed = 0.6; }], [1.5, (h) => { h.targetHeading = (degrees * Math.PI) / 180; }]], {
          onFrame: (t) => {
            if (human.position.y < 0.9) fell = true;
            for (const side of SIDES) {
              const f = loco.feet[side];
              if (prev[side] !== 'SWING' && f.phase === 'SWING') {
                highest = Math.max(highest, f.swing.height);
                if (t > 6) late++;
              }
            }
            prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
          },
        });
        assert.ok(!fell, 'se cayó del muro');
        assert.equal(late, 0, `siguió dando ${late} pasos contra el borde`);
        assert.ok(highest < 0.1, `un paso subió ${(highest * 100).toFixed(0)} cm`);
        for (const side of SIDES) assert.ok(loco.feet[side].planted.y > 0.9, `el pie ${side} quedó fuera del muro`);
      });
    }

    // Antes, girando sobre el muro mientras caminaba, los pasos (por delante del cuerpo, que miraba al costado) caían
    // fuera de él, en el aire, y el cuerpo llegaba al borde: lo frenaba solo el borde, como de una tarima.
    for (const [name, a, b] of [['−90° y de vuelta a lo largo', -90, 0], ['90° y media vuelta', 90, 180], ['30° y −30°', 30, -30]] as const) {
      it(`sobre el muro, girando ${name} mientras camina (escala ${scale}): los pies en él y el cuerpo lejos del borde`, () => {
        const world = onWall(scale);
        const { human } = world;
        const loco = human.locomotion;
        const deg = Math.PI / 180;
        let fell = false;
        let farthest = 0;
        const off: string[] = [];
        let prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
        simulate(world, 11, [[0, (h) => { h.targetSpeed = 0.6; }], [1.5, (h) => { h.targetHeading = a * deg; }], [5, (h) => { h.targetHeading = b * deg; }], [9, (h) => { h.targetSpeed = 0; }]], {
          onFrame: (t) => {
            const p = human.position;
            if (p.y < 0.9) fell = true;
            // Sobre el muro (sin sus extremos, junto a la plataforma y al pedestal).
            if (p.z < -2.1 && p.z > -5.5) farthest = Math.max(farthest, Math.abs(p.x - 4.75));
            for (const side of SIDES) {
              const f = loco.feet[side];
              if (prev[side] === 'SWING' && f.phase !== 'SWING') {
                const q = f.planted;
                if (q.z < -2.05 && q.z > -5.55 && Math.abs(q.x - 4.75) > 0.125) off.push(`${t.toFixed(1)} s, ${side}: ${((Math.abs(q.x - 4.75) - 0.125) * 100).toFixed(1)} cm`);
              }
            }
            prev = { left: loco.feet.left.phase, right: loco.feet.right.phase };
          },
        });
        assert.ok(!fell, 'se cayó del muro');
        assert.deepEqual(off, [], 'pasos fuera del muro');
        assert.ok(farthest < 0.095, `el cuerpo llegó a ${(farthest * 100).toFixed(1)} cm del eje (el borde, a 12,5)`);
      });
    }

    // Antes, la ruta añadía el punto de aproximación al camino angosto (para llegar en línea con él) aunque ya estuviera
    // en él: quedaba detrás, y se giraba, volvía medio metro y se giraba otra vez.
    for (const [name, heading, z] of [['al pedestal', 0, -6.3], ['a la plataforma', Math.PI, 0]] as const) {
      it(`desde el medio del muro, clic ${name}, que tiene delante (escala ${scale}): va directo`, () => {
        const world = onWall(scale);
        const { human } = world;
        const dir = Math.sign(z - human.position.z);
        let z0 = 0;
        let h0 = 0;
        let back = 0;
        let turn = 0;
        // Primero, de cara a ese lado (girar media vuelta en el muro lleva unos 3 s).
        simulate(world, 12, [[0, (h) => { h.targetHeading = heading; }], [4, (h) => {
          h.moveTo(new Vector3(4.75, 1.02, z));
          z0 = h.position.z;
          h0 = h.locomotion.body.state.heading;
        }]], {
          onFrame: (t) => {
            if (t < 4) return;
            back = Math.max(back, (human.position.z - z0) * -dir);
            const d = Math.abs(human.locomotion.body.state.heading - h0) % (2 * Math.PI);
            turn = Math.max(turn, Math.min(d, 2 * Math.PI - d));
          },
        });
        assert.ok(back < 0.03, `retrocedió ${(back * 100).toFixed(0)} cm`);
        assert.ok(turn < Math.PI / 6, `se giró ${((turn * 180) / Math.PI).toFixed(0)}°`);
        assert.ok(Math.abs(human.position.z - z) < 0.2 && human.position.y > 1, `no llegó (z ${human.position.z.toFixed(2)})`);
      });
    }
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

  // Clic en un punto de una viga baja, desde un lado: sube por el costado ahí mismo (no rodea su extremo), se gira
  // a lo largo de ella y se para con los dos pies arriba. Antes, subiendo de lado se quedaba atravesado y con un pie
  // en el suelo, dando pasos sin aclararse.
  // Ni pasa un pie por encima de la viga al suelo del otro lado, quedando a horcajadas (como escalón, la viga es más
  // corta que el pie y la escalera lo ponía detrás).
  for (const [sx, sz, scale] of [[0, 0, 1], [0, 4, 1], [3.5, 4, 1], [0.5, 2.5, 1], [0, 0, 0.896], [-1.5, 4, 0.896]] as const) {
    for (const z of [2, 4, 5.5]) {
      it(`clic en una viga baja (z = ${z}) desde (${sx}, ${sz}), escala ${scale}: sube por el costado y se para a lo largo de ella`, () => {
        const world = createWorld({ buildTerrain: lowBeam, modelScale: scale });
        const { human } = world;
        world.model.position.set(sx, 0, sz);
        world.model.updateMatrixWorld(true);
        human.reset();
        const loco = human.locomotion;
        const target = new Vector3(2, 0.3, z);
        human.moveTo(target);
        let both = false;
        let backDown = 0;
        let roundEnd = false;
        let farSide = 0;
        const side = Math.sign(sx - 2);
        const r = simulate(world, 16, [], {
          onFrame: () => {
            const up = SIDES.map((side) => human.footPhase(side) !== 'SWING' && loco.feet[side].planted.y > 0.2);
            if (up[0] && up[1]) both = true;
            for (const side of SIDES) if (both && human.footPhase(side) !== 'SWING' && loco.feet[side].planted.y < 0.2) backDown++;
            // Junto a la viga, más allá de sus extremos: la rodeaba.
            const p = human.position;
            if (Math.abs(p.x - 2) < 0.4 && (p.z < 1 || p.z > 7)) roundEnd = true;
            for (const s of SIDES) {
              const f = loco.feet[s].planted;
              if (human.footPhase(s) !== 'SWING' && (f.x - 2) * side < -0.1 && f.y < 0.2) farSide++;
            }
          },
        });
        assert.equal(human.moveTarget, null, 'no llegó');
        assert.ok(human.position.distanceTo(target) < 0.1, `se paró en ${human.position.toArray().map((v) => v.toFixed(2))}`);
        assert.ok(!roundEnd, 'rodeó el extremo de la viga');
        assert.equal(farSide, 0, 'un pie pasó la viga por encima y se apoyó al otro lado');
        assert.equal(backDown, 0, 'un pie volvió a bajar al suelo');
        for (const side of SIDES) {
          const p = loco.feet[side].planted;
          assert.ok(p.y > 0.2 && Math.abs(p.x - 2) < 0.07, `pie ${side} en ${p.toArray().map((v) => v.toFixed(2))}`);
        }
        assert.ok(Math.abs(loco.body.state.forward.z) > 0.99, 'no quedó a lo largo de la viga');
        assert.ok(human.balance > 0.99);
        assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001 && r.finiteOK);
      });
    }
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

  // Viga encima del borde de una tarima: de 20 × 25 cm sobre una tarima de 30 cm (x de −6,5 a −4, z de −2 a −6),
  // enrasada con su borde +X. Desde la tarima se sube a ella de un paso; desde fuera hay 55 cm (no se sube ni se baja),
  // y sus extremos dan al suelo: solo se sube desde la tarima, por el costado.
  const edgeBeam = (terrain: Object3D): void => {
    block(terrain, 2.5, 0.3, 4, -5.25, -4);
    const beamOnTop = new Mesh(new BoxGeometry(0.2, 0.25, 4), new MeshBasicMaterial());
    beamOnTop.position.set(-4.1, 0.3 + 0.125, -4);
    terrain.add(beamOnTop);
  };
  for (const [name, start, z] of [['el suelo de fuera', new Vector3(0, 0, 0), -4], ['el suelo, cerca de un extremo', new Vector3(0, 0, 0), -2.5], ['la tarima', new Vector3(-5.5, 0.3, -4), -4.5]] as const) {
    it(`viga encima del borde de una tarima, desde ${name}: sube a ella desde la tarima y se para a lo largo de ella`, () => {
      const world = createWorld({ buildTerrain: edgeBeam });
      const { human } = world;
      world.model.position.copy(start);
      world.model.updateMatrixWorld(true);
      human.reset();
      const loco = human.locomotion;
      const target = new Vector3(-4.1, 0.55, z);
      human.moveTo(target);
      let outside = 0;
      const r = simulate(world, 20, [], {
        onFrame: () => {
          // Un pie en el suelo de fuera, junto a la viga, con el cuerpo arriba.
          for (const side of SIDES) {
            const f = loco.feet[side].planted;
            if (human.footPhase(side) !== 'SWING' && human.position.y > 0.4 && f.y < 0.2 && f.x > -4 && f.x < -3.6) outside++;
          }
        },
      });
      assert.equal(human.moveTarget, null, 'no llegó');
      assert.ok(Math.hypot(human.position.x - target.x, human.position.z - target.z) < 0.1, `se paró en ${human.position.toArray().map((v) => v.toFixed(2))}`);
      assert.equal(outside, 0, 'un pie bajó al suelo de fuera');
      for (const side of SIDES) {
        const p = loco.feet[side].planted;
        assert.ok(p.y > 0.5 && Math.abs(p.x + 4.1) < 0.07, `pie ${side} en ${p.toArray().map((v) => v.toFixed(2))}`);
      }
      assert.ok(Math.abs(loco.body.state.forward.z) > 0.99, 'no quedó a lo largo de la viga');
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
