import { type Box3, Matrix4, Mesh, type Object3D, Vector3 } from 'three';

/** A vertical cylinder the character can't go through (world): a tree trunk, a column, a post. */
export interface ColliderCylinder {
  /** Center of its base. */
  center: Vector3;
  radius: number;
  /** Height above `center` (m); unlimited by default. */
  height?: number;
}

/** Something that isn't ground and the character goes round: a mesh (each of its meshes, by its box) or a cylinder. */
export type Collider = Object3D | ColliderCylinder;

/** Footprint of a mesh on the ground plane: a rectangle. */
interface Footprint {
  /** Rectangle → world (x, z) and back; sides in rectangle units, and metres per unit along each side. */
  matrix: Matrix4;
  inverse: Matrix4;
  min: Vector3;
  max: Vector3;
  scaleX: number;
  scaleZ: number;
  /** Heights (world) between which it is. */
  bottom: number;
  top: number;
}

const UP = new Vector3(0, 1, 0);
const CORNER = new Vector3();
const AXIS = new Vector3();
const LOCAL = new Vector3();
const CLOSEST = new Vector3();

/**
 * Obstacles that aren't ground, seen from above: what the character goes round (`moveTo` plans its route
 * round them) and doesn't go through. A cylinder is a circle; a mesh, the box of its geometry, turned like the
 * mesh (exact for walls, posts and railings made of boxes; a square round a cylinder; if the mesh is tilted,
 * its box in world). Give it simple shapes, visible or not (an invisible cylinder for a tree trunk): a
 * detailed mesh blocks the whole of its box, crown included.
 *
 * Only what is between `bottom` and `top` blocks (see `distance`): lower, the character steps on it (if it
 * is ground); higher (a beam, a lintel), it passes under it. They can move: `update` reads them again.
 */
export class Colliders {
  private readonly items: Collider[];
  private readonly footprints: Footprint[] = [];
  private used = 0;

  constructor(items: readonly Collider[]) {
    this.items = [...items];
    this.update();
  }

  /** Reads the meshes again (where they are now). */
  update(): void {
    this.used = 0;
    for (const item of this.items) {
      if (isCylinder(item)) continue;
      item.updateWorldMatrix(true, true);
      item.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const geometry = object.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox as Box3 | null;
        if (!box || box.isEmpty()) return;
        this.addFootprint(box, object.matrixWorld);
      });
    }
  }

  /**
   * Signed horizontal distance (m) from (`x`, `z`) to the nearest footprint of what is between the heights
   * `bottom` and `top` (world): negative inside. In `away`, the horizontal direction (unit) that leaves it
   * soonest. Infinity if there is none.
   */
  distance(x: number, z: number, bottom: number, top: number, away?: Vector3): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (const item of this.items) {
      if (!isCylinder(item)) continue;
      const base = item.center.y;
      if (base > top || base + (item.height ?? Number.POSITIVE_INFINITY) < bottom) continue;
      const dx = x - item.center.x;
      const dz = z - item.center.z;
      const r = Math.hypot(dx, dz);
      const d = r - item.radius;
      if (d < nearest) {
        nearest = d;
        if (away) away.set(r > 1e-9 ? dx / r : 1, 0, r > 1e-9 ? dz / r : 0);
      }
    }
    for (let k = 0; k < this.used; k++) {
      const f = this.footprints[k];
      if (f.bottom > top || f.top < bottom) continue;
      LOCAL.set(x, 0, z).applyMatrix4(f.inverse);
      const inside = LOCAL.x >= f.min.x && LOCAL.x <= f.max.x && LOCAL.z >= f.min.z && LOCAL.z <= f.max.z;
      let d: number;
      if (!inside) {
        // El punto más cercano del rectángulo, en world.
        CLOSEST.set(Math.min(Math.max(LOCAL.x, f.min.x), f.max.x), 0, Math.min(Math.max(LOCAL.z, f.min.z), f.max.z)).applyMatrix4(f.matrix);
        const dx = x - CLOSEST.x;
        const dz = z - CLOSEST.z;
        d = Math.hypot(dx, dz);
        if (d < nearest) {
          nearest = d;
          if (away) away.set(d > 1e-9 ? dx / d : 1, 0, d > 1e-9 ? dz / d : 0);
        }
      } else {
        // Dentro: hacia el lado más cercano (en metros).
        const sides = [(LOCAL.x - f.min.x) * f.scaleX, (f.max.x - LOCAL.x) * f.scaleX, (LOCAL.z - f.min.z) * f.scaleZ, (f.max.z - LOCAL.z) * f.scaleZ];
        let side = 0;
        for (let s = 1; s < 4; s++) if (sides[s] < sides[side]) side = s;
        d = -sides[side];
        if (d < nearest) {
          nearest = d;
          if (away) {
            AXIS.setFromMatrixColumn(f.matrix, side < 2 ? 0 : 2).setY(0).normalize();
            away.copy(AXIS).multiplyScalar(side % 2 === 0 ? -1 : 1);
          }
        }
      }
    }
    return nearest;
  }

  /** Footprint of a box (geometry, local) with the matrix of its mesh. */
  private addFootprint(box: Box3, matrix: Matrix4): void {
    if (this.used === this.footprints.length) {
      this.footprints.push({ matrix: new Matrix4(), inverse: new Matrix4(), min: new Vector3(), max: new Vector3(), scaleX: 1, scaleZ: 1, bottom: 0, top: 0 });
    }
    const f = this.footprints[this.used++];
    f.bottom = Number.POSITIVE_INFINITY;
    f.top = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 8; k++) {
      corner(box, k).applyMatrix4(matrix);
      f.bottom = Math.min(f.bottom, CORNER.y);
      f.top = Math.max(f.top, CORNER.y);
    }
    // Girada solo alrededor de la vertical (su eje y sigue vertical): su caja, en planta, con sus ejes.
    if (AXIS.setFromMatrixColumn(matrix, 1).normalize().dot(UP) > 0.999) {
      f.matrix.copy(matrix);
      f.min.copy(box.min);
      f.max.copy(box.max);
      f.scaleX = AXIS.setFromMatrixColumn(matrix, 0).length();
      f.scaleZ = AXIS.setFromMatrixColumn(matrix, 2).length();
    } else {
      // Inclinada (una baranda de escalera): su caja en world, en planta.
      f.matrix.identity();
      f.min.set(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);
      f.max.set(Number.NEGATIVE_INFINITY, 0, Number.NEGATIVE_INFINITY);
      for (let k = 0; k < 8; k++) {
        corner(box, k).applyMatrix4(matrix);
        f.min.set(Math.min(f.min.x, CORNER.x), 0, Math.min(f.min.z, CORNER.z));
        f.max.set(Math.max(f.max.x, CORNER.x), 0, Math.max(f.max.z, CORNER.z));
      }
      f.scaleX = 1;
      f.scaleZ = 1;
    }
    f.inverse.copy(f.matrix).invert();
  }
}

/** Corner `k` (0–7) of `box`, in the shared vector CORNER. */
function corner(box: Box3, k: number): Vector3 {
  return CORNER.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
}

function isCylinder(item: Collider): item is ColliderCylinder {
  return (item as ColliderCylinder).radius !== undefined && (item as ColliderCylinder).center !== undefined;
}
