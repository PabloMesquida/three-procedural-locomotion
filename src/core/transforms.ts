import { type Object3D, Quaternion, Vector3 } from 'three';

const _q = new Quaternion();
const _v = new Vector3();

/** Sets a world rotation on an object, converting it to its local space. */
export function setWorldQuaternion(obj: Object3D, worldQuat: Quaternion): void {
  if (obj.parent) {
    obj.parent.getWorldQuaternion(_q);
    obj.quaternion.copy(_q.invert().multiply(worldQuat));
  } else {
    obj.quaternion.copy(worldQuat);
  }
  obj.updateWorldMatrix(false, true);
}

/** Sets a world position on an object, converting it to its local space. */
export function setWorldPosition(obj: Object3D, worldPos: Vector3): void {
  _v.copy(worldPos);
  if (obj.parent) {
    obj.parent.updateWorldMatrix(true, false);
    obj.parent.worldToLocal(_v);
  }
  obj.position.copy(_v);
  obj.updateWorldMatrix(false, true);
}
