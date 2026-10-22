import { type Object3D, Quaternion, Vector3 } from 'three';

/**
 * Access to the pose of the bones for the controllers, without unnecessary recomputation.
 *
 * Three recomputes matrices in cascade: `getWorldPosition`/`getWorldQuaternion` walk all the ancestors
 * and `updateWorldMatrix(false, true)` everything below. Called for every bone that is read or rotated,
 * that multiplied the matrices of a frame by ~30. Here, instead:
 *
 *  - reading (`worldPosition`, `worldQuaternion`) takes the world matrix as it is: the caller guarantees
 *    it is up to date (it wrote it, or updated it with `updateNode`/`updateDown`);
 *  - writing (`setWorldQuaternionNode`, `setWorldPositionNode`) updates only that bone, with its parent up
 *    to date; whatever hangs from it is left pending (don't read it without `updateDown` first);
 *  - at the end of a stage, `updateSubtree` updates in one go everything below its first bone.
 *
 * The resulting matrices are exactly the same as with Three's calls: they are computed with the same
 * operations, just once.
 *
 * It is the only place where the controllers read and write the world pose: if the pose ever lives in
 * arrays of its own (outside Three's scene graph), only this module changes.
 */

const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _chain: Object3D[] = [];

/** Recomputes the world matrix of `obj` (only its own; its parent must be up to date). */
export function updateNode(obj: Object3D): void {
  obj.updateWorldMatrix(false, false);
}

/**
 * Recomputes, top-down, the nodes between `ancestor` (excluded; must be up to date) and `obj` (included).
 * If `ancestor` is not an ancestor of `obj`, recomputes the whole chain of ancestors.
 */
export function updateDown(ancestor: Object3D, obj: Object3D): void {
  _chain.length = 0;
  let node: Object3D | null = obj;
  while (node && node !== ancestor) {
    _chain.push(node);
    node = node.parent;
  }
  if (!node) {
    // No cuelga de `ancestor`: lo seguro es actualizar con todos sus antepasados.
    _chain.length = 0;
    obj.updateWorldMatrix(true, false);
    return;
  }
  for (let i = _chain.length - 1; i >= 0; i--) _chain[i].updateWorldMatrix(false, false);
  _chain.length = 0;
}

/** Recomputes everything below `obj` (and `obj`), with its parent up to date. */
export function updateSubtree(obj: Object3D): void {
  obj.updateWorldMatrix(false, true);
}

/** World position of `obj`, read from its matrix (must be up to date). */
export function worldPosition(obj: Object3D, out: Vector3): Vector3 {
  return out.setFromMatrixPosition(obj.matrixWorld);
}

/** World rotation of `obj`, read from its matrix (must be up to date). */
export function worldQuaternion(obj: Object3D, out: Quaternion): Quaternion {
  obj.matrixWorld.decompose(_p, out, _s);
  return out;
}

/** Sets a world rotation on `obj` (with its parent up to date) and updates only its matrix. */
export function setWorldQuaternionNode(obj: Object3D, worldQuat: Quaternion): void {
  if (obj.parent) obj.quaternion.copy(worldQuaternion(obj.parent, _q).invert().multiply(worldQuat));
  else obj.quaternion.copy(worldQuat);
  updateNode(obj);
}

/** Sets a world position on `obj` (with its parent up to date) and updates only its matrix. */
export function setWorldPositionNode(obj: Object3D, worldPos: Vector3): void {
  _p.copy(worldPos);
  if (obj.parent) obj.parent.worldToLocal(_p);
  obj.position.copy(_p);
  updateNode(obj);
}
