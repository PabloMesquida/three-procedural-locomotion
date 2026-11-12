import { DoubleSide, type Intersection, type Material, Matrix3, type Object3D, Raycaster, Vector3 } from 'three';

/** Result of querying the ground. All in world space. */
export interface GroundHit {
  point: Vector3;
  /** Normal of the ground, unit length and pointing up. */
  normal: Vector3;
  /** From the origin down to the point (m); negative if the origin is inside the ground (see `castDown`). */
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
  /**
   * Casts a vertical ray downwards. Returns false if there is no ground within `maxDistance`.
   *
   * If the origin is inside the ground (the nearest surface above it is the top of a block, seen from inside,
   * and not a ceiling seen from below), it returns that top, above the origin (negative `distance`): the
   * character searches the ground from `groundProbeHeight` above its feet, and that way a block taller than
   * that (a platform, a big rock) is a wall instead of something it walks into. The detectors of the library do
   * it for meshes with `FrontSide` or `BackSide` materials (a `DoubleSide` face has no inside).
   */
  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean;
}

/** How far above the origin it looks for the top of the ground the origin may be inside (m). */
export const INSIDE_SEARCH = 1000;
/**
 * Surfaces closer than this in height (m) are at the same height: a top and a ceiling there are two stacked
 * blocks (the origin is in the lower one), and a top that close above the origin isn't above it.
 */
export const INSIDE_TOLERANCE = 1e-7;

const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

/** The face hit has a single-sided material (`FrontSide` or `BackSide`): a block has an inside. */
function singleSided(hit: Intersection): boolean {
  const material = (hit.object as Object3D & { material?: Material | Material[] }).material;
  if (!material || !hit.face) return false;
  const used = Array.isArray(material) ? material[hit.face.materialIndex] : material;
  return used !== undefined && used.side !== DoubleSide;
}

/** GroundDetector based on THREE.Raycaster against a list of terrain objects. */
export class RaycastGroundDetector implements GroundDetector {
  /** Objects considered ground (traversed recursively). */
  targets: Object3D[];

  private readonly raycaster = new Raycaster();
  private readonly normalMatrix = new Matrix3();
  private readonly above = new Vector3();
  private readonly hits: Intersection[] = [];

  constructor(targets: Object3D[]) {
    this.targets = targets;
  }

  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean {
    // Un solo rayo, desde muy arriba hasta el alcance: ve a la vez lo que hay por encima del origen (por si está
    // dentro del suelo) y el suelo (lo primero a la altura del origen o por debajo).
    this.raycaster.set(this.above.set(origin.x, origin.y + INSIDE_SEARCH, origin.z), DOWN);
    this.raycaster.near = 0;
    this.raycaster.far = INSIDE_SEARCH + maxDistance;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.targets, true, this.hits);
    let top: Intersection | undefined;
    let ground: Intersection | undefined;
    for (const hit of this.hits) {
      if (hit.point.y <= origin.y) {
        ground = hit;
        break;
      }
      // De arriba abajo: se queda con la más baja por encima del origen.
      if (hit.point.y >= origin.y + INSIDE_TOLERANCE && singleSided(hit)) top = hit;
    }
    // Dentro del suelo: la superficie de un solo lado más cercana por encima del origen se ve desde arriba (la cara
    // de arriba de un bloque), no desde abajo (un techo).
    const hit = top && !this.ceilingBelow(origin, top.point.y) ? top : ground;
    if (!hit) return false;
    this.fill(hit, out);
    out.distance = origin.y - hit.point.y;
    return true;
  }

  /**
   * There is a single-sided surface seen from below (a ceiling) between the origin and the height `top` (one at
   * the same height as `top` doesn't count: two stacked blocks).
   */
  private ceilingBelow(origin: Vector3, top: number): boolean {
    this.raycaster.set(origin, UP);
    this.raycaster.near = 0;
    this.raycaster.far = top - origin.y - INSIDE_TOLERANCE;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.targets, true, this.hits);
    return this.hits.some(singleSided);
  }

  /** `out` from a hit of the raycaster: point and normal (world, pointing up). */
  private fill(hit: Intersection, out: GroundHit): void {
    out.point.copy(hit.point);

    // La normal del raycast está en espacio local del objeto → pasarla a world.
    const localNormal = hit.normal ?? hit.face?.normal;
    if (localNormal) {
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      out.normal.copy(localNormal).applyMatrix3(this.normalMatrix).normalize();
      if (out.normal.y < 0) out.normal.negate();
    } else {
      out.normal.set(0, 1, 0);
    }
  }
}
