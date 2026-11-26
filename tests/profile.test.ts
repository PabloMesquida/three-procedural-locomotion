import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';

import { RaycastGroundDetector } from '../src/index.ts';
import { GroundProfile } from '../src/terrain/GroundProfile.ts';

// El perfil del suelo a lo largo de un camino, y la línea que sigue el cuerpo sobre sus huellas.
describe('GroundProfile', () => {
  // Una tarima que se acaba antes del final del perfil, sin suelo después (el fondo de una grieta entre dos rocas, sin
  // suelo debajo): ese tramo sin suelo es la última huella, no un hueco entre dos, y la línea bajaba hacia la altura con
  // que se apunta (la raíz, en la isla del diorama, hasta 180 m).
  it('la línea no baja hacia un tramo sin suelo al final del perfil', () => {
    const group = new Group();
    const deck = new Mesh(new BoxGeometry(2, 1, 1.3), new MeshBasicMaterial());
    deck.position.set(0, -0.5, -0.35);
    group.add(deck);
    group.updateMatrixWorld(true);
    const profile = new GroundProfile();
    profile.setPath(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    profile.sample(new RaycastGroundDetector([group]), -0.8, 0.6, 0.05, 0.03, 0, 0.5, 0.5);
    assert.ok(profile.count >= 2, `${profile.count} huellas`);
    for (let u = -0.8; u <= 0.6; u += 0.05) {
      const y = profile.line(u, 0.2);
      assert.ok(Number.isNaN(y) || y > -0.01, `línea a ${y.toFixed(2)} m en u = ${u.toFixed(2)}`);
    }
  });
});
