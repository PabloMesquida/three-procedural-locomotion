import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Quaternion, Vector3 } from 'three';

import { estimateForward, LegIK, mapHumanRig } from '../src/index.ts';
import { MODEL_MAPPING, MODEL_PATH } from './helpers/sim.ts';
import { loadSkeleton } from './helpers/skeleton.ts';

function setup() {
  const model = loadSkeleton(MODEL_PATH);
  // Estos tests prueban que el solver es exacto: se quita el redondeo de las escalas de los huesos
  // de algunos rigs exportados (Mixamo pasado por Blender: muslos a 0,999993), que por sí solo
  // desvía el pie ~0,002 mm y ~0,015°.
  model.traverse((o) => {
    if (o.scale.toArray().every((s) => Math.abs(s - 1) < 1e-4)) o.scale.set(1, 1, 1);
  });
  model.updateMatrixWorld(true);
  const { rig } = mapHumanRig(model, MODEL_MAPPING);
  const forward = estimateForward(rig, 'toes');
  const ik = new LegIK(rig.left, forward);
  const hip = rig.left.thigh.getWorldPosition(new Vector3());
  const ankle = rig.left.foot.getWorldPosition(new Vector3());
  const reach = hip.distanceTo(rig.left.shin.getWorldPosition(new Vector3())) + rig.left.shin.getWorldPosition(new Vector3()).distanceTo(ankle);
  return { rig, forward, ik, hip, ankle, reach };
}

describe('IK de dos huesos (pierna)', () => {
  it('alcanza objetivos dentro de su alcance (error < 0,001 mm) y dobla la rodilla hacia delante', () => {
    const { rig, forward, ik, hip, ankle } = setup();
    const targets = [
      ankle.clone().add(new Vector3(0, 0.25, 0)),
      ankle.clone().addScaledVector(forward, 0.3).add(new Vector3(0, 0.15, 0)),
      ankle.clone().addScaledVector(forward, -0.25).add(new Vector3(0.05, 0.3, 0)),
    ];
    for (const target of targets) {
      const pole = hip.clone().addScaledVector(forward, 1);
      const result = ik.solve(target, pole);
      assert.ok(result.reachable);
      assert.ok(result.error < 1e-6, `error ${result.error}`);
      assert.ok(rig.left.foot.getWorldPosition(new Vector3()).distanceTo(target) < 1e-6);
      // La rodilla queda por delante de la línea cadera → tobillo.
      const knee = rig.left.shin.getWorldPosition(new Vector3());
      const line = target.clone().sub(hip).normalize();
      const offset = knee.clone().sub(hip);
      offset.addScaledVector(line, -offset.dot(line));
      assert.ok(offset.dot(forward) > 0, 'la rodilla se dobla hacia atrás');
    }
  });

  it('con un objetivo fuera de alcance estira la pierna hacia él (casi recta) y devuelve el error', () => {
    const { rig, ik, hip, reach } = setup();
    const target = hip.clone().add(new Vector3(0, -(reach + 0.2), 0.1));
    const result = ik.solve(target, hip.clone().add(new Vector3(0, 0, -1)));
    assert.equal(result.reachable, false);
    const foot = rig.left.foot.getWorldPosition(new Vector3());
    // El solver se queda al 99,99 % del alcance (rodilla nunca del todo recta: evita la singularidad).
    assert.ok(Math.abs(foot.distanceTo(hip) - reach * (1 - 1e-4)) < 1e-6, 'la pierna no queda estirada');
    assert.ok(Math.abs(result.error - foot.distanceTo(target)) < 1e-9);
    // El pie queda en la línea cadera → objetivo.
    const dir = target.clone().sub(hip).normalize();
    assert.ok(foot.clone().sub(hip).normalize().angleTo(dir) < 1e-6);
  });

  it('conserva la orientación del pie pedida', () => {
    const { rig, forward, ik, hip, ankle } = setup();
    const wanted = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3).multiply(rig.left.foot.getWorldQuaternion(new Quaternion()));
    ik.solve(ankle.clone().add(new Vector3(0, 0.2, 0)), hip.clone().addScaledVector(forward, 1), wanted);
    // < 0,006°: exacto salvo el redondeo de las escalas de algunos rigs exportados (Rigify: 4e-5 rad).
    assert.ok(rig.left.foot.getWorldQuaternion(new Quaternion()).angleTo(wanted) < 1e-4, `${rig.left.foot.getWorldQuaternion(new Quaternion()).angleTo(wanted)} rad`);
  });
});
