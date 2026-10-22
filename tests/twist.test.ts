import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bone, Euler, type Object3D, Quaternion, Vector3 } from 'three';

import { TWIST_SHARE, TwistController, twistAngle } from '../src/body/TwistController.ts';
import { type HumanRigMapping, mapHumanRig, mixamoMapping } from '../src/index.ts';
import { loadSkeleton } from './helpers/skeleton.ts';
import { createWorld, simulate } from './helpers/sim.ts';

const MODEL_PATH = 'modelos/human_mix_propio.glb';
const DEG = Math.PI / 180;

/** Añade un hueso de torsión hijo de `segmentName`, a mitad del segmento y con un reposo arbitrario. */
function addTwist(model: Object3D, segmentName: string, childName: string, name: string, at: number): void {
  const segment = model.getObjectByName(segmentName)!;
  const child = model.getObjectByName(childName)!;
  const twist = new Bone();
  twist.name = name;
  twist.position.copy(child.position).multiplyScalar(at);
  // Un reposo cualquiera: el controlador no debe suponer que el twist está alineado con el segmento.
  twist.quaternion.setFromEuler(new Euler(0.3, -0.7, 1.1));
  segment.add(twist);
}

/** El modelo de Mixamo de los tests con huesos de torsión en el brazo y la pierna izquierdos. */
function withTwists(model: Object3D): Object3D {
  addTwist(model, 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'upperArmTwistL', 0);
  addTwist(model, 'mixamorigLeftForeArm', 'mixamorigLeftHand', 'forearmTwistL', 0.5);
  addTwist(model, 'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'thighTwistL', 0);
  addTwist(model, 'mixamorigLeftLeg', 'mixamorigLeftFoot', 'shinTwistL', 0.5);
  model.updateMatrixWorld(true);
  return model;
}

const twistMapping: HumanRigMapping = {
  ...mixamoMapping,
  left: { ...mixamoMapping.left, thighTwist: 'thighTwistL', shinTwist: 'shinTwistL' },
  leftArm: { ...mixamoMapping.leftArm!, upperArmTwist: 'upperArmTwistL', forearmTwist: 'forearmTwistL' },
};

/** Ángulo (rad) que giró `bone` respecto a `rest` alrededor del eje world `axis`, y lo que giró fuera de él. */
function rotationAbout(bone: Bone, restWorld: Quaternion, axis: Vector3): { twist: number; swing: number } {
  const now = bone.getWorldQuaternion(new Quaternion());
  const delta = now.multiply(restWorld.clone().invert()); // en world
  const twist = twistAngle(delta, axis);
  const swing = 2 * Math.acos(Math.min(1, Math.abs(delta.multiply(new Quaternion().setFromAxisAngle(axis, -twist)).w)));
  return { twist, swing };
}

/** Dirección world del segmento (de `segment` a `child`). */
function segmentAxis(segment: Bone, child: Bone): Vector3 {
  return child.getWorldPosition(new Vector3()).sub(segment.getWorldPosition(new Vector3())).normalize();
}

describe('torsión de brazos y piernas', () => {
  it('el antebrazo recibe la mitad del giro de la mano alrededor de su eje, y nada de su flexión', () => {
    const model = withTwists(loadSkeleton(MODEL_PATH));
    const { rig, warnings } = mapHumanRig(model, twistMapping);
    assert.deepEqual(warnings.filter((w) => /twist bone/i.test(w)), []);
    const arm = rig.leftArm!;
    const twist = new TwistController(rig);
    assert.equal(twist.count, 4);

    const axis = segmentAxis(arm.forearm, arm.hand);
    const rest = arm.forearmTwist!.getWorldQuaternion(new Quaternion());
    const restLocal = arm.forearmTwist!.quaternion.clone();

    // Pronación de 80° (alrededor del eje del antebrazo) + flexión de muñeca de 30°.
    const parentQ = arm.forearm.getWorldQuaternion(new Quaternion());
    const toLocal = (v: Vector3): Vector3 => v.clone().applyQuaternion(parentQ.clone().invert());
    const bendAxis = toLocal(new Vector3().crossVectors(axis, new Vector3(0, 1, 0)).normalize());
    arm.hand.quaternion.premultiply(new Quaternion().setFromAxisAngle(toLocal(axis), 80 * DEG));
    arm.hand.quaternion.premultiply(new Quaternion().setFromAxisAngle(bendAxis, 30 * DEG));
    twist.update();
    model.updateMatrixWorld(true);

    const r = rotationAbout(arm.forearmTwist!, rest, axis);
    assert.ok(Math.abs(r.twist - TWIST_SHARE * 80 * DEG) < 0.5 * DEG, `torsión ${(r.twist / DEG).toFixed(2)}°`);
    assert.ok(r.swing < 0.5 * DEG, `se dobló ${(r.swing / DEG).toFixed(2)}°`);

    twist.reset();
    const back = arm.forearmTwist!.quaternion.angleTo(restLocal);
    assert.ok(back < 1e-6, `reset no vuelve al reposo: ${back}`);
  });

  it('el muslo y el brazo deshacen cerca del cuerpo la mitad de su propio giro axial', () => {
    const model = withTwists(loadSkeleton(MODEL_PATH));
    const { rig } = mapHumanRig(model, twistMapping);
    const twist = new TwistController(rig);
    for (const [segment, child, bone] of [
      [rig.left.thigh, rig.left.shin, rig.left.thighTwist!],
      [rig.leftArm!.upperArm, rig.leftArm!.forearm, rig.leftArm!.upperArmTwist!],
    ] as const) {
      const axis = segmentAxis(segment, child);
      const restSegment = segment.getWorldQuaternion(new Quaternion());
      const rest = bone.getWorldQuaternion(new Quaternion());
      const parentQ = segment.parent!.getWorldQuaternion(new Quaternion()).invert();
      segment.quaternion.premultiply(new Quaternion().setFromAxisAngle(axis.clone().applyQuaternion(parentQ), 50 * DEG));
      twist.update();
      model.updateMatrixWorld(true);

      assert.ok(Math.abs(rotationAbout(segment, restSegment, axis).twist - 50 * DEG) < 1e-6);
      const r = rotationAbout(bone, rest, axis);
      assert.ok(Math.abs(r.twist - (1 - TWIST_SHARE) * 50 * DEG) < 0.5 * DEG, `${bone.name}: ${(r.twist / DEG).toFixed(2)}°`);
      assert.ok(r.swing < 0.5 * DEG, `${bone.name} se dobló ${(r.swing / DEG).toFixed(2)}°`);
    }
  });

  it('un giro sin torsión (solo flexión del segmento) no mueve los huesos de torsión respecto a él', () => {
    const model = withTwists(loadSkeleton(MODEL_PATH));
    const { rig } = mapHumanRig(model, twistMapping);
    const twist = new TwistController(rig);
    const bone = rig.left.thighTwist!;
    const restLocal = bone.quaternion.clone();
    const axis = segmentAxis(rig.left.thigh, rig.left.shin);
    // Flexión de cadera: el eje del muslo se mueve hacia delante, sin girar sobre sí mismo.
    const target = axis.clone().add(new Vector3(0, 0, 0.8)).normalize();
    const parentQ = rig.left.thigh.parent!.getWorldQuaternion(new Quaternion()).invert();
    rig.left.thigh.quaternion.premultiply(
      new Quaternion().setFromUnitVectors(axis.clone().applyQuaternion(parentQ), target.applyQuaternion(parentQ)),
    );
    twist.update();
    assert.ok(bone.quaternion.angleTo(restLocal) < 1e-6, `giró ${(bone.quaternion.angleTo(restLocal) / DEG).toFixed(3)}°`);
  });

  // Añade los huesos de torsión con nombres de Mixamo: solo con el modelo de los tests.
  it('caminando no cambia nada más del esqueleto: los huesos de la cadena quedan igual que sin torsión', { skip: process.env.PH_MODEL ? 'usa el modelo de Mixamo' : false }, () => {
    const run = (twists: boolean) => {
      const world = createWorld({
        prepare: twists ? withTwists : undefined,
        mapping: twists ? twistMapping : undefined,
      });
      let maxTwist = 0;
      simulate(world, 3, [[0, (h) => { h.targetSpeed = 1.2; h.targetHeading = 1.5; }]], {
        onFrame: () => {
          if (!twists) return;
          const t = world.human.rig.left.shinTwist!;
          maxTwist = Math.max(maxTwist, t.quaternion.angleTo(new Quaternion()));
        },
      });
      const rig = world.human.rig;
      const bones = [rig.left.foot, rig.right.foot, rig.leftArm!.hand, rig.head!];
      return { positions: bones.map((b) => b.getWorldPosition(new Vector3())), maxTwist, rig };
    };
    const plain = run(false);
    const twisted = run(true);
    plain.positions.forEach((p, i) => assert.ok(p.distanceTo(twisted.positions[i]) < 1e-9, `bone ${i} se movió`));
    assert.ok(Number.isFinite(twisted.maxTwist));
  });

  it('avisa una sola vez si el modelo no tiene ninguno, y descarta un twist que no es hijo de su segmento', () => {
    const { rig, warnings } = mapHumanRig(loadSkeleton(MODEL_PATH), twistMapping);
    assert.equal(warnings.filter((w) => /twist bone/i.test(w)).length, 1, warnings.join(' | '));
    assert.equal(rig.left.thighTwist, undefined);

    const model = loadSkeleton(MODEL_PATH);
    addTwist(model, 'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'thighTwistL', 0);
    addTwist(model, 'mixamorigLeftFoot', 'mixamorigLeftToeBase', 'shinTwistL', 0.5); // padre equivocado
    const mapped = mapHumanRig(model, { ...mixamoMapping, left: twistMapping.left });
    assert.ok(mapped.rig.left.thighTwist);
    assert.equal(mapped.rig.left.shinTwist, undefined);
    assert.ok(mapped.warnings.some((w) => w.includes('shinTwistL') && w.includes('direct child')), mapped.warnings.join(' | '));
  });
});
