import { Matrix3, type Object3D, Raycaster, Vector3 } from 'three';

/** Result of querying the ground. All in world space. */
export interface GroundHit {
  point: Vector3;
  /** Normal of the ground, unit length and pointing up. */
  normal: Vector3;
  distance: number;
}

export function createGroundHit(): GroundHit {
  return { point: new Vector3(), normal: new Vector3(0, 1, 0), distance: 0 };
}

/**
 * Abstraction of "where is the ground?".
 * Today it is implemented with Three.js raycasts; later it could be implemented with a physics engine
 * without touching FootPlacement.
 */
export interface GroundDetector {
  /** Casts a vertical ray downwards. Returns false if there is no ground within `maxDistance`. */
  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean;
}

const DOWN = new Vector3(0, -1, 0);

/** GroundDetector based on THREE.Raycaster against a list of terrain objects. */
export class RaycastGroundDetector implements GroundDetector {
  /** Objects considered ground (traversed recursively). */
  targets: Object3D[];

  private readonly raycaster = new Raycaster();
  private readonly normalMatrix = new Matrix3();

  constructor(targets: Object3D[]) {
    this.targets = targets;
  }

  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean {
    this.raycaster.set(origin, DOWN);
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;

    const hit = this.raycaster.intersectObjects(this.targets, true)[0];
    if (!hit) return false;

    out.point.copy(hit.point);
    out.distance = hit.distance;

    // La normal del raycast está en espacio local del objeto → pasarla a world.
    const localNormal = hit.normal ?? hit.face?.normal;
    if (localNormal) {
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      out.normal.copy(localNormal).applyMatrix3(this.normalMatrix).normalize();
      if (out.normal.y < 0) out.normal.negate();
    } else {
      out.normal.set(0, 1, 0);
    }
    return true;
  }
}
