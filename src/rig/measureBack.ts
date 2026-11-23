import { type Bone, type Object3D, SkinnedMesh, Vector3 } from 'three';

import type { HumanRig } from './HumanRig.ts';

/** How far the back of the model sticks out behind its hips (the bone), measured on its mesh (world, m). */
export interface BackExtent {
  /** At the height of the hips (the buttocks). */
  hips: number;
  /** At the height of the chest (the shoulder blades). */
  chest: number;
}

/** Fewer skinned vertices than this in a band: it doesn't trust the measure. */
const MIN_VERTICES = 8;

/**
 * Heights of the two bands the back is measured in, from the root (m, world): the hips (around the hip joints, the
 * buttocks) and the chest (from halfway up the trunk to the shoulders). Without a neck or a chest bone, the
 * shoulders are taken to be at 1.5 × the height of the hips.
 */
export function backBands(rig: HumanRig): { hips: [number, number]; chest: [number, number] } {
  rig.root.updateMatrixWorld(true);
  const root = rig.root.getWorldPosition(new Vector3()).y;
  const hips = rig.hips.getWorldPosition(new Vector3()).y - root;
  const top = rig.neck ?? rig.chest;
  const shoulders = top ? Math.max(top.getWorldPosition(new Vector3()).y - root, hips * 1.2) : hips * 1.5;
  return {
    hips: [hips * 0.8, hips * 1.1],
    chest: [hips + (shoulders - hips) * 0.5, shoulders],
  };
}

/**
 * Measures, on the skinned meshes of the model in its current pose (when the character is created, its rest pose,
 * standing), how far behind the hips bone (horizontally, against `forward`) the back reaches: of the vertices moved
 * most by the hips, the spine, the chest or the thighs, those in each band of `backBands`. Standing upright with its
 * back against a wall, the hips are that far from it. null for a model without such vertices (only the skeleton) or a
 * band with too few.
 */
export function measureBack(rig: HumanRig, forward: Vector3): BackExtent | null {
  rig.root.updateMatrixWorld(true);
  const meshes: SkinnedMesh[] = [];
  rig.root.traverse((object: Object3D) => {
    if (object instanceof SkinnedMesh && object.skeleton && object.geometry.getAttribute('skinIndex')) meshes.push(object);
  });
  if (meshes.length === 0) return null;
  const bones = new Set<Bone>([rig.hips, rig.left.thigh, rig.right.thigh]);
  for (const bone of [rig.spine, rig.chest, rig.left.thighTwist, rig.right.thighTwist]) if (bone) bones.add(bone);
  const root = rig.root.getWorldPosition(new Vector3());
  const hips = rig.hips.getWorldPosition(new Vector3());
  const back = new Vector3(-forward.x, 0, -forward.z).normalize();
  const bands = backBands(rig);
  const result = { hips: Number.NEGATIVE_INFINITY, chest: Number.NEGATIVE_INFINITY };
  const counts = { hips: 0, chest: 0 };
  const v = new Vector3();
  for (const mesh of meshes) {
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const position = mesh.geometry.getAttribute('position');
    if (!index || !weight || !position) continue;
    const ofTrunk = mesh.skeleton.bones.map((bone) => bones.has(bone));
    if (!ofTrunk.some(Boolean)) continue;
    for (let i = 0; i < position.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, best)) best = k;
      if (!ofTrunk[index.getComponent(i, best)]) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      const y = v.y - root.y;
      const d = (v.x - hips.x) * back.x + (v.z - hips.z) * back.z;
      for (const band of ['hips', 'chest'] as const) {
        const [lo, hi] = bands[band];
        if (y < lo || y > hi) continue;
        result[band] = Math.max(result[band], d);
        counts[band]++;
      }
    }
  }
  if (counts.hips < MIN_VERTICES || counts.chest < MIN_VERTICES || !(result.hips > 0) || !(result.chest > 0)) return null;
  return result;
}
