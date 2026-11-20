import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type BufferAttribute, type Line, type Mesh, Vector3 } from 'three';

import * as debug from '../src/debug/index.ts';
import { NavigationDebug } from '../src/debug/index.ts';
import { createWorld, simulate } from './helpers/sim.ts';

/** El aro y la línea de una NavigationDebug (en ese orden en su grupo). */
function parts(nav: NavigationDebug): { ring: Mesh; line: Line; positions: BufferAttribute } {
  const [ring, line] = nav.group.children as [Mesh, Line];
  return { ring, line, positions: line.geometry.getAttribute('position') as BufferAttribute };
}

describe('three-procedural-locomotion/debug', () => {
  it('exporta las ayudas', () => {
    for (const name of ['FootDebug', 'GaitDiagram', 'IKDebug', 'LocomotionDebug', 'NavigationDebug', 'RigDebug'] as const) {
      assert.equal(typeof debug[name], 'function', `falta ${name}`);
    }
  });

  describe('NavigationDebug', () => {
    it('con una ruta planificada (un tronco en medio): el aro en el destino y la línea desde los pies por la ruta', () => {
      const world = createWorld({ human: { colliders: [{ center: new Vector3(0, 0, -4), radius: 0.15 }] } });
      const { human } = world;
      const nav = new NavigationDebug(human);
      const { ring, line, positions } = parts(nav);
      assert.equal(ring.visible, false);
      assert.equal(line.visible, false);
      const target = new Vector3(0, 0, -8);
      human.moveTo(target);
      assert.ok(human.movePath, 'no planeó una ruta');
      const buffer = positions.array;
      simulate(world, 1, [], { onFrame: () => nav.update() });
      assert.ok(ring.visible && line.visible);
      assert.ok(ring.position.distanceTo(new Vector3(target.x, target.y + 0.01, target.z)) < 1e-9);
      // Desde los pies (2 cm sobre el suelo bajo el cuerpo) y por lo que queda de la ruta, hasta el destino.
      const count = line.geometry.drawRange.count;
      const route = human.movePath!;
      assert.equal(count, route.length + 1);
      assert.ok(Math.abs(positions.getX(0) - human.position.x) < 1e-6 && Math.abs(positions.getZ(0) - human.position.z) < 1e-6);
      assert.ok(Math.abs(positions.getY(0) - (human.locomotion.body.state.groundHeight + 0.02)) < 1e-6);
      const last = new Vector3(positions.getX(count - 1), positions.getY(count - 1), positions.getZ(count - 1));
      assert.ok(last.distanceTo(new Vector3(target.x, target.y + 0.02, target.z)) < 1e-5);
      // Sin crear geometría por frame: el mismo buffer.
      assert.equal(positions.array, buffer);
      // Al llegar, desaparecen.
      simulate(world, 12, [], { start: 1, onFrame: () => nav.update() });
      assert.equal(human.moveTarget, null);
      assert.ok(!ring.visible && !line.visible);
      nav.dispose();
    });

    it('en línea recta: el aro y, solo con straightLine, la línea de los pies al destino', () => {
      for (const straightLine of [false, true]) {
        const world = createWorld();
        const { human } = world;
        const nav = new NavigationDebug(human, { straightLine, color: 0xff0000 });
        const { ring, line, positions } = parts(nav);
        human.moveTo(new Vector3(0.5, 0, -5));
        assert.equal(human.movePath, null);
        simulate(world, 0.5, [], { onFrame: () => nav.update() });
        assert.ok(ring.visible);
        assert.equal((ring.material as unknown as { color: { getHex(): number } }).color.getHex(), 0xff0000);
        assert.equal(line.visible, straightLine);
        if (straightLine) {
          assert.equal(line.geometry.drawRange.count, 2);
          assert.ok(Math.abs(positions.getX(1) - 0.5) < 1e-9 && Math.abs(positions.getZ(1) + 5) < 1e-9);
        }
        nav.visible = false;
        assert.equal(nav.group.visible, false);
      }
    });
  });
});
