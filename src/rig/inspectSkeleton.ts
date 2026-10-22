import { Bone, Object3D, SkinnedMesh } from 'three';

/** A bone found in the model, with its position in the hierarchy. */
export interface BoneInfo {
  name: string;
  depth: number;
  parentName: string | null;
}

export interface SkeletonReport {
  bones: BoneInfo[];
  skinnedMeshes: string[];
  /** Bone hierarchy as indented text, ready to show or copy. */
  tree: string;
}

/**
 * Walks a loaded object and lists all its bones.
 * It doesn't interpret names: it only shows them, so that you can then write an explicit rig mapping.
 *
 * Note: GLTFLoader sanitizes node names (it removes `[ ] . : /` and turns spaces into `_`), so
 * `mixamorig:Hips` shows up here as `mixamorigHips`. These are the names to use.
 */
export function inspectSkeleton(root: Object3D): SkeletonReport {
  const bones: BoneInfo[] = [];
  const skinnedMeshes: string[] = [];
  const lines: string[] = [];

  const visit = (obj: Object3D, depth: number): void => {
    let childDepth = depth;

    if (obj instanceof Bone) {
      const parentName = obj.parent instanceof Bone ? obj.parent.name : null;
      bones.push({ name: obj.name, depth, parentName });
      lines.push(`${'  '.repeat(depth)}${obj.name}`);
      childDepth = depth + 1;
    } else if (obj instanceof SkinnedMesh) {
      skinnedMeshes.push(obj.name);
    }

    for (const child of obj.children) visit(child, childDepth);
  };

  visit(root, 0);

  return { bones, skinnedMeshes, tree: lines.join('\n') };
}
