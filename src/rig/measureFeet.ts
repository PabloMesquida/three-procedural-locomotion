import { type Bone, type Object3D, SkinnedMesh, Vector3 } from 'three';

import type { HumanRig, LegBones, Side } from './HumanRig.ts';

/** How far the foot of the model reaches, measured on its mesh (world, m). */
export interface FootExtent {
  /** From the ankle, ahead (along the foot, horizontally), to the tips of the toes. */
  front: number;
  /** From the ankle, behind, to the back of the heel (0 if it doesn't stick out behind the ankle). */
  back: number;
}

/** Fewer skinned vertices than this under the ankle: it doesn't trust the measure. */
const MIN_VERTICES = 8;

/**
 * Measures the feet on the skinned meshes of the model, in its current pose (when the character is created,
 * its rest pose, standing): of the vertices that the foot, the toes or the shin move most, those below the
 * ankle (the sole and the shoe), how far they reach ahead of the ankle and behind it, along the foot
 * (ankle → toe joint; `forward` if there is no toe bone). The proportions vary a lot from one model to
 * another (a shoe, a toe joint placed far back), and the steps and stairs need them: the tips of the toes
 * mustn't go into a riser nor the heel hang over an edge.
 *
 * null for a side without such vertices (a model without meshes, e.g. only the skeleton) or a measure that
 * doesn't make sense (the tips behind the toe joint).
 */
export function measureFeet(rig: HumanRig, forward: Vector3): Record<Side, FootExtent | null> {
  rig.root.updateMatrixWorld(true);
  const meshes: SkinnedMesh[] = [];
  rig.root.traverse((object: Object3D) => {
    if (object instanceof SkinnedMesh && object.skeleton && object.geometry.getAttribute('skinIndex')) meshes.push(object);
  });
  return { left: measureFoot(rig.left, meshes, forward), right: measureFoot(rig.right, meshes, forward) };
}

function measureFoot(leg: LegBones, meshes: SkinnedMesh[], forward: Vector3): FootExtent | null {
  const ankle = leg.foot.getWorldPosition(new Vector3());
  const toe = leg.toe?.getWorldPosition(new Vector3());
  const along = toe ? toe.clone().sub(ankle).setY(0) : forward.clone().setY(0);
  if (along.lengthSq() < 1e-12) return null;
  along.normalize();
  const bones = new Set<Bone>([leg.foot, leg.shin]);
  if (leg.toe) bones.add(leg.toe);
  if (leg.shinTwist) bones.add(leg.shinTwist);

  const v = new Vector3();
  let front = Number.NEGATIVE_INFINITY;
  let back = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const mesh of meshes) {
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const position = mesh.geometry.getAttribute('position');
    if (!index || !weight || !position) continue;
    // Qué huesos del esqueleto de esta malla son de este pie.
    const ofFoot = mesh.skeleton.bones.map((bone) => bones.has(bone));
    if (!ofFoot.some(Boolean)) continue;
    for (let i = 0; i < position.count; i++) {
      // El hueso que más mueve el vértice.
      let best = 0;
      for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, best)) best = k;
      if (!ofFoot[index.getComponent(i, best)]) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      if (v.y > ankle.y) continue;
      const d = (v.x - ankle.x) * along.x + (v.z - ankle.z) * along.z;
      front = Math.max(front, d);
      back = Math.max(back, -d);
      count++;
    }
  }
  if (count < MIN_VERTICES) return null;
  const toeJoint = toe ? (toe.x - ankle.x) * along.x + (toe.z - ankle.z) * along.z : 0;
  if (!(front > toeJoint)) return null;
  return { front, back: Math.max(back, 0) };
}
