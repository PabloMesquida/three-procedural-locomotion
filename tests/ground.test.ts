import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

import { createTerrain, type TerrainKind } from './helpers/terrains.ts';
import { createGroundHit, type GroundDetector, RaycastGroundDetector, StaticGroundDetector } from '../src/index.ts';
import { createWorld, simulate, SIDES } from './helpers/sim.ts';

/** Generador pseudoaleatorio determinista. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Lanza los mismos rayos verticales con los dos detectores y devuelve la mayor diferencia
 * (punto, normal, distancia) y cuántos rayos dieron suelo en uno y no en el otro.
 */
function compare(ground: Object3D, extent: number, rays = 3000, seed = 1): { hits: number; mismatches: number; error: number } {
  ground.updateMatrixWorld(true);
  const reference: GroundDetector = new RaycastGroundDetector([ground]);
  const fast: GroundDetector = new StaticGroundDetector([ground]);
  const a = createGroundHit();
  const b = createGroundHit();
  const origin = new Vector3();
  const rnd = random(seed);
  let hits = 0;
  let mismatches = 0;
  let error = 0;
  for (let i = 0; i < rays; i++) {
    origin.set((rnd() * 2 - 1) * extent, rnd() * 3 - 0.5, (rnd() * 2 - 1) * extent);
    const maxDistance = 0.5 + rnd() * 3;
    const ha = reference.castDown(origin, maxDistance, a);
    const hb = fast.castDown(origin, maxDistance, b);
    if (ha !== hb) {
      mismatches++;
      continue;
    }
    if (!ha) continue;
    hits++;
    error = Math.max(error, a.point.distanceTo(b.point), a.normal.distanceTo(b.normal), Math.abs(a.distance - b.distance));
  }
  return { hits, mismatches, error };
}

const plane = (side: typeof FrontSide | typeof BackSide | typeof DoubleSide): Mesh =>
  new Mesh(new PlaneGeometry(4, 4).rotateX(-Math.PI / 2), new MeshBasicMaterial({ side }));

describe('StaticGroundDetector', () => {
  it('da el mismo suelo que el raycast de Three en los terrenos de los tests', () => {
    for (const kind of ['flat', 'slopeSide', 'slopeFront', 'bumpy'] as TerrainKind[]) {
      // La pista irregular tiene ~23.000 triángulos: el raycast de referencia es lento, menos rayos.
      const rays = kind === 'bumpy' ? 800 : 3000;
      const r = compare(createTerrain(kind), kind === 'bumpy' ? 3 : 8, rays);
      assert.ok(r.hits > rays / 3, `${kind}: solo ${r.hits} rayos con suelo`);
      assert.equal(r.mismatches, 0, `${kind}: ${r.mismatches} rayos con suelo en un detector y no en el otro`);
      assert.ok(r.error < 1e-6, `${kind}: diferencia ${r.error}`);
    }
  });

  it('respeta lo mismo que el raycast: caras, escalas negativas, grupos, drawRange, capas, sin índice, varios pisos', () => {
    const cases: Record<string, () => Object3D> = {
      // Plano mirando hacia abajo: con FrontSide no se toca desde arriba; con BackSide y DoubleSide, sí.
      'abajo FrontSide': () => plane(FrontSide).rotateX(Math.PI),
      'abajo BackSide': () => plane(BackSide).rotateX(Math.PI),
      'abajo DoubleSide': () => plane(DoubleSide).rotateX(Math.PI),
      'escala negativa': () => { const m = plane(FrontSide); m.scale.set(-1, 1, 1.5); m.position.y = 0.3; return m; },
      // Reflejado en Y: la cara delantera queda mirando hacia abajo y deja de ser suelo (como en Three).
      'escala negativa en Y': () => { const m = plane(FrontSide); m.scale.set(1, -1, 1); return m; },
      'esfera girada y escalada (normales suaves)': () => {
        const m = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial());
        m.rotation.z = 0.4;
        m.position.y = 0.2;
        m.scale.set(1.5, 0.6, 1);
        return m;
      },
      'grupos de materiales': () => {
        const box = new BoxGeometry(2, 0.5, 2, 3, 2, 3);
        return new Mesh(box, [FrontSide, BackSide, DoubleSide, FrontSide, BackSide, DoubleSide].map((side) => new MeshBasicMaterial({ side })));
      },
      drawRange: () => { const m = new Mesh(new PlaneGeometry(4, 4, 4, 4).rotateX(-Math.PI / 2), new MeshBasicMaterial()); m.geometry.setDrawRange(6, 30); return m; },
      'capa 1 (se ignora)': () => { const g = new Group(); const hidden = plane(FrontSide); hidden.position.y = 0.5; hidden.layers.set(1); g.add(hidden, plane(FrontSide)); return g; },
      'sin índice y sin normales': () => {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute([-2, 0, 2, 2, 0.4, 2, 2, 0, -2, -2, 0, 2, 2, 0, -2, -2, -0.3, -2], 3));
        return new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }));
      },
      'dos pisos y escalones': () => {
        const g = new Group();
        g.add(plane(FrontSide));
        const upper = plane(FrontSide); upper.position.y = 1.2; upper.scale.set(0.5, 1, 0.5); g.add(upper);
        for (let i = 0; i < 5; i++) { const step = new Mesh(new BoxGeometry(1, 0.17, 0.3), new MeshBasicMaterial()); step.position.set(-1, 0.085 + i * 0.17, -1 + i * 0.3); g.add(step); }
        return g;
      },
    };
    const notGround = ['abajo FrontSide', 'escala negativa en Y'];
    for (const [name, make] of Object.entries(cases)) {
      const ground = make();
      const r = compare(ground, 2.5, 2000);
      assert.equal(r.mismatches, 0, `${name}: ${r.mismatches} rayos con suelo en un detector y no en el otro`);
      assert.ok(r.error < 1e-6, `${name}: diferencia ${r.error}`);
      if (notGround.includes(name)) assert.equal(r.hits, 0, `${name}: una cara FrontSide mirando hacia abajo no es suelo`);
      else assert.ok(r.hits > 100, `${name}: solo ${r.hits} rayos con suelo`);
    }
  });

  it('rebuild() recoge los cambios del suelo', () => {
    const ground = new Group().add(plane(FrontSide));
    const detector = new StaticGroundDetector([ground]);
    const hit = createGroundHit();
    assert.ok(detector.castDown(new Vector3(0, 1, 0), 2, hit) && Math.abs(hit.point.y) < 1e-12);
    ground.position.y = 0.4;
    assert.ok(detector.castDown(new Vector3(0, 1, 0), 2, hit) && Math.abs(hit.point.y) < 1e-12, 'sin rebuild sigue la foto');
    detector.rebuild();
    assert.ok(detector.castDown(new Vector3(0, 1, 0), 2, hit) && Math.abs(hit.point.y - 0.4) < 1e-9);
  });

  it('caminando por la pista irregular, el movimiento es el mismo que con el raycast de Three', () => {
    const run = (staticGround: boolean): Vector3[] => {
      const world = createWorld({ terrain: 'bumpy', staticGround });
      const samples: Vector3[] = [];
      simulate(world, 8, [[0, (h) => { h.targetSpeed = 1.2; }], [3, (h) => { h.targetHeading = 0.6; }], [6, (h) => { h.targetSpeed = 0; }]], {
        onFrame: () => { for (const side of SIDES) samples.push(world.human.rig[side].foot.getWorldPosition(new Vector3())); },
      });
      return samples;
    };
    const a = run(false);
    const b = run(true);
    assert.equal(a.length, b.length);
    const error = Math.max(...a.map((p, i) => p.distanceTo(b[i])));
    assert.ok(error < 1e-5, `los pies difieren hasta ${(error * 1000).toFixed(4)} mm`);
  });
});
