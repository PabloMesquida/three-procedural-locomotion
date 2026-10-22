import { Matrix3, type Object3D, Raycaster, Vector3 } from 'three';

/** Result of looking for a surface. All in world space. */
export interface SurfaceHit {
  point: Vector3;
  /** Normal of the surface, unit length and pointing towards whoever cast the ray. */
  normal: Vector3;
  distance: number;
  /**
   * Object hit (optional): so as not to touch the same one again while it is still within reach (a long
   * wall, once). Without it, the distance to the last point touched is used.
   */
  object?: unknown;
}

export function createSurfaceHit(): SurfaceHit {
  return { point: new Vector3(), normal: new Vector3(0, 0, 1), distance: 0 };
}

/**
 * Abstraction of "what is within reach of the hand?" (columns, walls, railings…), like GroundDetector for
 * the ground: today with Three.js raycasts, tomorrow with a physics engine.
 */
export interface SurfaceDetector {
  /** Casts a ray (`direction` unit length). Returns false if it hits nothing within `maxDistance`. */
  cast(origin: Vector3, direction: Vector3, maxDistance: number, out: SurfaceHit): boolean;
}

/** SurfaceDetector based on THREE.Raycaster against a list of touchable objects. */
export class RaycastSurfaceDetector implements SurfaceDetector {
  /** Objects that can be touched (traversed recursively). */
  targets: Object3D[];

  private readonly raycaster = new Raycaster();
  private readonly normalMatrix = new Matrix3();

  constructor(targets: Object3D[]) {
    this.targets = targets;
  }

  cast(origin: Vector3, direction: Vector3, maxDistance: number, out: SurfaceHit): boolean {
    this.raycaster.set(origin, direction);
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;

    const hit = this.raycaster.intersectObjects(this.targets, true)[0];
    if (!hit) return false;

    out.point.copy(hit.point);
    out.distance = hit.distance;
    out.object = hit.object;
    const localNormal = hit.normal ?? hit.face?.normal;
    if (localNormal) {
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      out.normal.copy(localNormal).applyMatrix3(this.normalMatrix).normalize();
      if (out.normal.dot(direction) > 0) out.normal.negate();
    } else {
      out.normal.copy(direction).negate();
    }
    return true;
  }
}
