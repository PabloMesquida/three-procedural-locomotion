import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';

import { type Collider, Colliders } from '../src/index.ts';
import { createWorld, horizontalDistance, simulate } from './helpers/sim.ts';

/** Un tronco de 15 cm de radio a 4 m por delante (el personaje mira hacia −Z). */
const trunk = (): Collider => ({ center: new Vector3(0, 0, -4), radius: 0.15 });
/** El mismo tronco como malla invisible (un cilindro: lo que conviene dar en vez de un árbol detallado). */
function trunkMesh(): Mesh {
  const mesh = new Mesh(new CylinderGeometry(0.15, 0.15, 2, 16), new MeshBasicMaterial());
  mesh.position.set(0, 1, -4);
  mesh.visible = false;
  return mesh;
}
/** Una pared de `length` m × 2 m × 20 cm a 4 m por delante, girada `degrees` alrededor de la vertical. */
function wall(degrees: number, length = 3): Mesh {
  const mesh = new Mesh(new BoxGeometry(length, 2, 0.2), new MeshBasicMaterial());
  mesh.position.set(0, 1, -4);
  mesh.rotation.y = (degrees * Math.PI) / 180;
  return mesh;
}

/** Simula con `colliders` y mide lo más cerca que pasa la raíz de ellos y lo más lento que va en una ruta. */
function run(colliders: Collider[], seconds: number, start: (h: ReturnType<typeof createWorld>['human']) => void) {
  const world = createWorld({ human: { colliders } });
  const { human } = world;
  const check = new Colliders(colliders);
  let closest = Number.POSITIVE_INFINITY;
  let slowest = Number.POSITIVE_INFINITY;
  let arrivals = 0;
  human.on('arrive', () => arrivals++);
  let route: Vector3[] | null = null;
  simulate(world, seconds, [[0, (h) => { start(h); route = h.movePath; }]], {
    onFrame: (t) => {
      const p = human.position;
      closest = Math.min(closest, check.distance(p.x, p.z, 0.35, 1.8));
      const target = human.moveTarget;
      if (t > 1.5 && target && horizontalDistance(p, target) > 1.2) slowest = Math.min(slowest, human.speed);
    },
  });
  return { human, closest, slowest, arrivals, route: route as Vector3[] | null };
}

describe('colliders', () => {
  for (const [name, make] of [['un cilindro', trunk], ['una malla invisible', trunkMesh]] as const) {
    it(`moveTo detrás de un tronco (${name}): lo rodea desde el principio, sin frenar, y llega`, () => {
      const target = new Vector3(0, 0, -8);
      const r = run([make()], 12, (h) => h.moveTo(target));
      assert.ok(r.route && r.route.length > 1, 'no planeó una ruta');
      assert.equal(r.arrivals, 1);
      assert.ok(horizontalDistance(r.human.position, target) < 0.1);
      // Con el cuerpo fuera (bodyRadius, 24 cm) y algo de holgura; el diorama lo rodeaba a mano a ~0,45 m.
      assert.ok(r.closest > 0.3, `pasó a ${r.closest.toFixed(2)} m del tronco`);
      assert.ok(r.slowest > 1.2, `bajó a ${r.slowest.toFixed(2)} m/s`);
    });
  }

  it('moveTo detrás de una pared girada: la rodea y llega', () => {
    const target = new Vector3(0.3, 0, -8);
    const r = run([wall(30)], 14, (h) => h.moveTo(target));
    assert.equal(r.arrivals, 1);
    assert.ok(horizontalDistance(r.human.position, target) < 0.1);
    assert.ok(r.closest > 0.3, `pasó a ${r.closest.toFixed(2)} m de la pared`);
  });

  it('lo que está por encima de la cabeza (un dintel) no estorba: va en línea recta', () => {
    const lintel = new Mesh(new BoxGeometry(3, 0.3, 0.3), new MeshBasicMaterial());
    lintel.position.set(0, 2.25, -4);
    const r = run([lintel], 9, (h) => h.moveTo(new Vector3(0, 0, -8)));
    assert.equal(r.route, null);
    assert.equal(r.arrivals, 1);
  });

  it('un destino dentro del tronco: llega a su borde', () => {
    const r = run([trunk()], 8, (h) => h.moveTo(new Vector3(0, 0, -4)));
    assert.equal(r.arrivals, 1);
    assert.ok(r.closest > 0.2 && r.closest < 0.6, `se paró a ${r.closest.toFixed(2)} m del tronco`);
  });

  it('con sus controles, de frente contra una pared: se para delante, sin atravesarla', () => {
    const r = run([wall(0)], 8, (h) => { h.targetSpeed = 1.2; });
    assert.ok(r.closest > 0.18, `se metió hasta ${r.closest.toFixed(2)} m de la pared`);
    assert.ok(r.human.speed < 0.05, `sigue a ${r.human.speed.toFixed(2)} m/s`);
    assert.ok(r.human.position.z > -4, 'la atravesó');
  });

  it('con sus controles, en diagonal contra una pared: se desliza a lo largo de ella', () => {
    const r = run([wall(0, 20)], 6, (h) => { h.targetHeading = Math.PI / 4; h.targetSpeed = 1.2; });
    assert.ok(r.closest > 0.18, `se metió hasta ${r.closest.toFixed(2)} m de la pared`);
    assert.ok(r.human.position.z > -4, 'la atravesó');
    // Mirando 45° a un lado, la pared lo desvía: avanza a lo largo de ella (en x) más de lo que le dejaba en z.
    assert.ok(Math.abs(r.human.position.x) > 2, `avanzó ${Math.abs(r.human.position.x).toFixed(2)} m a lo largo`);
  });

  // Como en el Laboratorio: una escalera de 17 × 28 cm (pasillo de 0,9 m) que sube hacia −Z a un rellano, con
  // barandas a x = ±0,4 m (pasamanos inclinados y postes) que son colliders: entre ellas quedan 37 cm a cada lado
  // del centro, de sobra para el cuerpo (24 cm). Antes, medida la distancia desde las celdas de la grilla con un
  // margen de media celda, el pasillo no cabía y rodeaba la tarima por fuera.
  // Con el destino en el rellano, en un escalón pegado a la baranda o en la cara lateral de un escalón (un clic
  // en el costado de la escalera, a media altura). En los dos últimos no cabe: el punto más cercano que alcanza
  // es en la escalera, no el suelo de fuera, al otro lado de la baranda, que en planta queda más cerca.
  const cases: [from: Vector3, kind: 'landing' | 'step' | 'side'][] = [
    [new Vector3(0, 0, 0), 'landing'],
    [new Vector3(-2.5, 0, -1), 'landing'],
    [new Vector3(-2, 0, -6), 'landing'],
    [new Vector3(0, 0, 0), 'step'],
    [new Vector3(0, 0, 0), 'side'],
  ];
  for (const [from, kind] of cases) {
    it(`a una tarima con barandas (desde ${from.x}, ${from.z}, ${{ landing: 'al rellano', step: 'a un escalón junto a la baranda', side: 'a la cara lateral de un escalón' }[kind]}): sube por la escalera, entre ellas`, () => {
      const rise = 0.17;
      const run = 0.28;
      const start = 2;
      const top = rise * 8;
      const landing = start + run * 7;
      const box = (t: Object3D, w: number, h: number, d: number, x: number, y: number, z: number): void => {
        const m = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
        m.position.set(x, y + h / 2, z);
        t.add(m);
      };
      const rails = new Group();
      const railing = (x: number, z0: number, y0: number, z1: number, y1: number, height: number): void => {
        const length = Math.hypot(z1 - z0, y1 - y0);
        for (const [y, thickness] of [[height, 0.05], [height / 2, 0.025]]) {
          const rail = new Mesh(new BoxGeometry(0.05, thickness, length), new MeshBasicMaterial());
          rail.position.set(x, (y0 + y1) / 2 + y, -(z0 + z1) / 2);
          rail.rotation.x = Math.atan2(y1 - y0, z1 - z0);
          rails.add(rail);
        }
        const posts = Math.ceil(z1 - z0);
        for (let i = 0; i <= posts; i++) box(rails, 0.04, height + rise, 0.04, x, y0 + ((y1 - y0) * i) / posts - rise, -(z0 + ((z1 - z0) * i) / posts));
      };
      for (const side of [-1, 1]) {
        railing(side * 0.4, start, rise, landing, top, 0.85);
        railing(side * 0.4, landing, top, landing + 4, top, 0.95);
        box(rails, 0.18, 1.1, 0.18, side * 0.45, 0, -(start - 0.15));
      }
      const world = createWorld({
        buildTerrain: (t) => {
          for (let i = 0; i < 7; i++) box(t, 0.9, rise * (i + 1), run, 0, 0, -(start + run * (i + 0.5)));
          box(t, 0.9, top, 4, 0, 0, -(landing + 2));
        },
        place: (model, scene) => { model.position.copy(from); scene.add(model); scene.add(rails); },
        human: { colliders: [rails] },
      });
      const { human } = world;
      const check = new Colliders([rails]);
      // En el escalón 5 (a 0,85 m), a 2 cm de la baranda; en su cara lateral, a media altura; o en el rellano.
      const target = kind === 'step' ? new Vector3(0.36, rise * 5, -(start + run * 4.5))
        : kind === 'side' ? new Vector3(0.45, rise * 2.5, -(start + run * 4.5))
        : new Vector3(0, top, -(landing + 2));
      let arrivals = 0;
      let closest = Number.POSITIVE_INFINITY;
      human.on('arrive', () => arrivals++);
      simulate(world, 16, [[0, (h) => h.moveTo(target)]], {
        onFrame: () => {
          const p = human.position;
          closest = Math.min(closest, check.distance(p.x, p.z, p.y + 0.35, p.y + 1.8));
        },
      });
      assert.equal(arrivals, 1);
      if (kind !== 'landing') {
        // En la escalera, en ese escalón (con la raíz sobre la línea de los escalones, ±1 escalón).
        assert.ok(Math.abs(human.position.y - rise * 5) < rise, `se quedó a ${human.position.y.toFixed(2)} m de altura`);
        assert.ok(Math.abs(human.position.x) < 0.3, `se quedó fuera de la escalera (x ${human.position.x.toFixed(2)})`);
      } else {
        assert.ok(horizontalDistance(human.position, target) < 0.1 && Math.abs(human.position.y - top) < 0.01, 'no llegó al rellano');
      }
      assert.ok(closest > 0.2, `pasó a ${closest.toFixed(2)} m de una baranda`);
    });
  }

  it('sin colliders (null) vuelve a ir en línea recta', () => {
    const world = createWorld({ human: { colliders: [trunk()] } });
    world.human.moveTo(new Vector3(0, 0, -8));
    assert.ok(world.human.movePath);
    world.human.colliders = null;
    world.human.moveTo(new Vector3(0, 0, -8));
    assert.equal(world.human.movePath, null);
  });
});
