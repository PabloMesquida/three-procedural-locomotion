import {
  BackSide,
  type BufferGeometry,
  DoubleSide,
  FrontSide,
  Layers,
  type Material,
  Matrix3,
  type Mesh,
  type Object3D,
  type Side,
  Vector3,
} from 'three';

import { type GroundDetector, type GroundHit, INSIDE_SEARCH, INSIDE_TOLERANCE } from './GroundDetector.ts';

/** Triangles per leaf of the tree. */
const LEAF_SIZE = 8;
/**
 * Relative tolerance of the point-in-triangle test: a ray right on an edge doesn't slip between two
 * triangles.
 */
const EDGE_EPSILON = 1e-9;
/** Maximum depth of the tree (splitting at the median leaves it at ~log2(triangles / LEAF_SIZE)). */
const MAX_DEPTH = 64;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _n = new Vector3();
const _normalMatrix = new Matrix3();

/**
 * GroundDetector for STATIC ground with many triangles (terrains, stairs, cities).
 *
 * When created, it copies, in world coordinates, the triangles of the meshes in `targets` (and their
 * children) that a vertical ray can hit, and sorts them into a tree by their footprint seen from above
 * (XZ) and their height range. Each `castDown` only walks the branches under the point: a few triangles
 * instead of all of them, whatever the size of the mesh. It returns the same as `RaycastGroundDetector`
 * (the first ground below the origin, with the normal pointing up: the interpolated vertex normal, or the
 * face normal if the mesh has no normals), respecting the same things as Three's raycast:
 * material side (FrontSide / BackSide / DoubleSide), groups, `drawRange`, layers (layer 0) and negative
 * scales. Also the same when the origin is inside the ground (see `GroundDetector.castDown`): for that it
 * also indexes the single-sided faces seen from below.
 *
 * It is a snapshot: if the ground moves or changes, call `rebuild()` (for ground that moves every frame,
 * use `RaycastGroundDetector`). One detector serves all the characters in the scene.
 * Regular meshes only: InstancedMesh, SkinnedMesh and BatchedMesh are ignored (with a warning).
 */
export class StaticGroundDetector implements GroundDetector {
  /** Objects considered ground (traversed recursively when building and in `rebuild`). */
  targets: Object3D[];

  /** The faces a vertical ray downwards can hit (tops, and the double-sided ones). */
  private tops: TriangleTree = EMPTY_TREE;
  /**
   * World normals of the vertices of each triangle of `tops` (9 numbers; without normals in the mesh, the face
   * normal ×3).
   */
  private normals = new Float64Array(0);
  /** Per triangle of `tops`: 1 if its material is `DoubleSide` (it has no inside). */
  private twoSided = new Uint8Array(0);
  /** The single-sided faces a vertical ray upwards can hit (ceilings and the bottoms of blocks). */
  private ceilings: TriangleTree = EMPTY_TREE;
  private readonly stack = new Int32Array(MAX_DEPTH * 2);
  private readonly layers = new Layers();

  constructor(targets: Object3D[]) {
    this.targets = targets;
    this.rebuild();
  }

  /** Indexed triangles (the ones a vertical ray can hit, from above or from below). */
  get triangleCount(): number {
    return this.tops.order.length + this.ceilings.order.length;
  }

  /** Reads the meshes in `targets` again (after moving them, changing them or changing the list). */
  rebuild(): void {
    const tops = new TriangleBuffer();
    const ceilings = new TriangleBuffer();
    const unsupported = new Set<string>();
    for (const target of this.targets) {
      target.updateWorldMatrix(true, true);
      target.traverse((obj) => {
        const mesh = obj as Mesh;
        if (!mesh.isMesh) return;
        const flags = mesh as unknown as Record<string, unknown>;
        if (flags.isInstancedMesh || flags.isSkinnedMesh || flags.isBatchedMesh) {
          unsupported.add(mesh.type);
          return;
        }
        if (!mesh.layers.test(this.layers)) return;
        collectTriangles(mesh, tops, ceilings);
      });
    }
    if (unsupported.size > 0) {
      console.warn(`StaticGroundDetector: ${[...unsupported].join(', ')} not supported, ignored (use RaycastGroundDetector).`);
    }
    this.tops = buildTree(tops.vertices.slice(0, tops.count * 9));
    this.normals = tops.normals.slice(0, tops.count * 9);
    this.twoSided = tops.twoSided.slice(0, tops.count);
    this.ceilings = buildTree(ceilings.vertices.slice(0, ceilings.count * 9));
  }

  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean {
    const x = origin.x;
    const z = origin.z;
    // Dentro del suelo: la superficie de un solo lado más cercana por encima del origen se ve desde arriba (la cara
    // de arriba de un bloque), no desde abajo (un techo; uno a la misma altura no cuenta: dos bloques apilados).
    const top = lowestAbove(this.tops, x, z, origin.y + INSIDE_TOLERANCE, origin.y + INSIDE_SEARCH, this.twoSided, this.stack);
    if (top >= 0) {
      const topY = _found;
      if (lowestAbove(this.ceilings, x, z, origin.y, topY - INSIDE_TOLERANCE, null, this.stack) < 0) {
        this.fill(top, x, topY, z, out);
        out.distance = origin.y - topY;
        return true;
      }
    }
    const { bounds, nodes, order, vertices: v } = this.tops;
    const stack = this.stack;
    if (order.length === 0) return false;
    const ceiling = origin.y;
    const bottom = origin.y - maxDistance;
    let bestY = -Infinity;
    let best = -1;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const b = node * 6;
      if (x < bounds[b] || x > bounds[b + 1] || z < bounds[b + 2] || z > bounds[b + 3]) continue;
      // Todo el nodo por encima del origen, o por debajo del alcance o del mejor suelo hallado.
      if (bounds[b + 4] > ceiling || bounds[b + 5] < bottom || bounds[b + 5] <= bestY) continue;
      const count = nodes[node * 2 + 1];
      if (count === 0) {
        stack[sp++] = nodes[node * 2];
        stack[sp++] = node + 1;
        continue;
      }
      const start = nodes[node * 2];
      for (let i = start; i < start + count; i++) {
        const t = order[i];
        const y = triangleHeight(v, t * 9, x, z);
        if (!(y <= ceiling) || y < bottom || y <= bestY) continue;
        bestY = y;
        best = t;
      }
    }
    if (best < 0) return false;
    this.fill(best, x, bestY, z, out);
    out.distance = ceiling - bestY;
    return true;
  }

  /** `out` on triangle `t` of `tops` at (x, y, z), with the normal interpolated like Three's raycast (pointing up). */
  private fill(t: number, x: number, y: number, z: number, out: GroundHit): void {
    out.point.set(x, y, z);
    // Normal interpolada con las coordenadas baricéntricas del punto (como el raycast de Three).
    const v = this.tops.vertices;
    const o = t * 9;
    const wc = (v[o + 3] - v[o]) * (z - v[o + 2]) - (v[o + 5] - v[o + 2]) * (x - v[o]);
    const wa = (v[o + 6] - v[o + 3]) * (z - v[o + 5]) - (v[o + 8] - v[o + 5]) * (x - v[o + 3]);
    const area = (v[o + 3] - v[o]) * (v[o + 8] - v[o + 2]) - (v[o + 5] - v[o + 2]) * (v[o + 6] - v[o]);
    const la = wa / area;
    const lc = wc / area;
    const lb = 1 - la - lc;
    const nn = this.normals;
    out.normal.set(
      la * nn[o] + lb * nn[o + 3] + lc * nn[o + 6],
      la * nn[o + 1] + lb * nn[o + 4] + lc * nn[o + 7],
      la * nn[o + 2] + lb * nn[o + 5] + lc * nn[o + 8],
    );
    if (out.normal.lengthSq() === 0) out.normal.set(0, 1, 0);
    out.normal.normalize();
    if (out.normal.y < 0) out.normal.negate();
  }
}

/** Triangles sorted into a tree by their footprint seen from above (XZ) and their height range. */
interface TriangleTree {
  /** World vertices of each triangle (9 numbers: a, b, c). */
  vertices: Float64Array;
  /** Triangles in the order of the leaves. */
  order: Uint32Array;
  /** Per node: minX, maxX, minZ, maxZ, minY, maxY. */
  bounds: Float64Array;
  /**
   * Per node: leaf → [start in `order`, number of triangles]; internal → [right child, 0] (the left one is
   * the next node).
   */
  nodes: Int32Array;
}

const EMPTY_TREE: TriangleTree = { vertices: new Float64Array(0), order: new Uint32Array(0), bounds: new Float64Array(0), nodes: new Int32Array(0) };

/** Height found by the last `lowestAbove`. */
let _found = 0;

/**
 * Height (m) of triangle `v[o..o+9)` at (x, z); NaN if (x, z) is outside its footprint. Edge functions in plan:
 * the point is inside if the three have the sign of the area.
 */
function triangleHeight(v: Float64Array, o: number, x: number, z: number): number {
  const ax = v[o], ay = v[o + 1], az = v[o + 2];
  const bx = v[o + 3], by = v[o + 4], bz = v[o + 5];
  const cx = v[o + 6], cy = v[o + 7], cz = v[o + 8];
  const wc = (bx - ax) * (z - az) - (bz - az) * (x - ax);
  const wa = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
  const wb = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
  const area = wa + wb + wc;
  const tolerance = -EDGE_EPSILON * Math.abs(area);
  if (area > 0 ? wa < tolerance || wb < tolerance || wc < tolerance : wa > -tolerance || wb > -tolerance || wc > -tolerance) return Number.NaN;
  return (wa * ay + wb * by + wc * cy) / area;
}

/**
 * The lowest triangle of `tree` at (x, z) with its height between `low` and `high` (both included), skipping
 * those marked in `skip`: its index (its height, in `_found`), or −1.
 */
function lowestAbove(tree: TriangleTree, x: number, z: number, low: number, high: number, skip: Uint8Array | null, stack: Int32Array): number {
  const { bounds, nodes, order, vertices: v } = tree;
  if (order.length === 0) return -1;
  let bestY = Infinity;
  let best = -1;
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp];
    const b = node * 6;
    if (x < bounds[b] || x > bounds[b + 1] || z < bounds[b + 2] || z > bounds[b + 3]) continue;
    if (bounds[b + 5] < low || bounds[b + 4] > high || bounds[b + 4] >= bestY) continue;
    const count = nodes[node * 2 + 1];
    if (count === 0) {
      stack[sp++] = nodes[node * 2];
      stack[sp++] = node + 1;
      continue;
    }
    const start = nodes[node * 2];
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      if (skip && skip[t]) continue;
      const y = triangleHeight(v, t * 9, x, z);
      if (!(y >= low) || y > high || y >= bestY) continue;
      bestY = y;
      best = t;
    }
  }
  _found = bestY;
  return best;
}

/**
 * Tree built by splitting at the median of the longest axis (X or Z) of the centers, depth first.
 * Each leaf's box is that of its triangles and each internal node's, the union of its children.
 */
function buildTree(vertices: Float64Array): TriangleTree {
  const n = vertices.length / 9;
  const v = vertices;
  const centerX = new Float64Array(n);
  const centerZ = new Float64Array(n);
  const triBounds = new Float64Array(n * 6);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    centerX[t] = (v[o] + v[o + 3] + v[o + 6]) / 3;
    centerZ[t] = (v[o + 2] + v[o + 5] + v[o + 8]) / 3;
    const b = t * 6;
    triBounds[b] = Math.min(v[o], v[o + 3], v[o + 6]);
    triBounds[b + 1] = Math.max(v[o], v[o + 3], v[o + 6]);
    triBounds[b + 2] = Math.min(v[o + 2], v[o + 5], v[o + 8]);
    triBounds[b + 3] = Math.max(v[o + 2], v[o + 5], v[o + 8]);
    triBounds[b + 4] = Math.min(v[o + 1], v[o + 4], v[o + 7]);
    triBounds[b + 5] = Math.max(v[o + 1], v[o + 4], v[o + 7]);
  }
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t++) order[t] = t;
  // Al dividir por la mediana, cada hoja (salvo con menos triángulos en total) tiene al menos
  // ⌊(LEAF_SIZE + 1) / 2⌋: hay como mucho n / eso hojas y menos del doble de nodos.
  const maxNodes = 2 * Math.ceil(n / Math.floor((LEAF_SIZE + 1) / 2)) + 1;
  const bounds = new Float64Array(maxNodes * 6);
  const nodes = new Int32Array(maxNodes * 2);
  let nodeCount = 0;

  const build = (start: number, end: number, depth: number): void => {
    const node = nodeCount++;
    const nb = node * 6;
    let cMinX = Infinity, cMaxX = -Infinity, cMinZ = Infinity, cMaxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i];
      if (centerX[t] < cMinX) cMinX = centerX[t];
      if (centerX[t] > cMaxX) cMaxX = centerX[t];
      if (centerZ[t] < cMinZ) cMinZ = centerZ[t];
      if (centerZ[t] > cMaxZ) cMaxZ = centerZ[t];
    }
    const count = end - start;
    if (count <= LEAF_SIZE || depth >= MAX_DEPTH - 1 || (cMaxX === cMinX && cMaxZ === cMinZ)) {
      nodes[node * 2] = start;
      nodes[node * 2 + 1] = count;
      bounds.fill(Infinity, nb, nb + 6);
      for (let k = 1; k < 6; k += 2) bounds[nb + k] = -Infinity;
      for (let i = start; i < end; i++) unionBounds(bounds, nb, triBounds, order[i] * 6);
      return;
    }
    const key = cMaxX - cMinX >= cMaxZ - cMinZ ? centerX : centerZ;
    const mid = (start + end) >> 1;
    selectMedian(order, key, start, end - 1, mid);
    build(start, mid, depth + 1);
    const right = nodeCount;
    build(mid, end, depth + 1);
    nodes[node * 2] = right;
    nodes[node * 2 + 1] = 0;
    bounds.copyWithin(nb, (node + 1) * 6, (node + 2) * 6);
    unionBounds(bounds, nb, bounds, right * 6);
  };
  if (n > 0) build(0, n, 0);
  return { vertices, order, bounds: bounds.slice(0, nodeCount * 6), nodes: nodes.slice(0, nodeCount * 2) };
}

/** Expands the box `target[t..t+6)` (minX, maxX, minZ, maxZ, minY, maxY) with `source[s..s+6)`. */
function unionBounds(target: Float64Array, t: number, source: Float64Array, s: number): void {
  for (let k = 0; k < 6; k += 2) {
    if (source[s + k] < target[t + k]) target[t + k] = source[s + k];
    if (source[s + k + 1] > target[t + k + 1]) target[t + k + 1] = source[s + k + 1];
  }
}

/**
 * Vertices and normals of the collected triangles (9 numbers per triangle each) and whether each one is
 * double-sided, with growing capacity.
 */
class TriangleBuffer {
  count = 0;
  vertices = new Float64Array(9 * 1024);
  normals = new Float64Array(9 * 1024);
  twoSided = new Uint8Array(1024);

  /** Makes room for `extra` more triangles. */
  reserve(extra: number): void {
    const needed = (this.count + extra) * 9;
    if (needed <= this.vertices.length) return;
    const size = Math.max(needed, this.vertices.length * 2);
    const vertices = new Float64Array(size);
    vertices.set(this.vertices);
    const normals = new Float64Array(size);
    normals.set(this.normals);
    const twoSided = new Uint8Array(size / 9);
    twoSided.set(this.twoSided);
    this.vertices = vertices;
    this.normals = normals;
    this.twoSided = twoSided;
  }
}

/**
 * Reorders `order[left..right]` so that position `k` holds the element that would be there when sorted by
 * `key`, with smaller or equal ones before and greater or equal ones after (quickselect, linear time).
 */
function selectMedian(order: Uint32Array, key: Float64Array, left: number, right: number, k: number): void {
  while (right > left) {
    // Pivote: mediana de tres.
    const mid = (left + right) >> 1;
    const a = key[order[left]], b = key[order[mid]], c = key[order[right]];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let i = left;
    let j = right;
    while (i <= j) {
      while (key[order[i]] < pivot) i++;
      while (key[order[j]] > pivot) j--;
      if (i <= j) {
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}

/**
 * Adds the triangles of `mesh` that a vertical ray downwards can hit (as its raycast would) to `tops`, and
 * the single-sided ones a vertical ray upwards can hit to `ceilings` (without normals).
 */
function collectTriangles(mesh: Mesh, tops: TriangleBuffer, ceilings: TriangleBuffer): void {
  const geometry = mesh.geometry as BufferGeometry;
  const position = geometry.attributes.position;
  if (!position) return;
  const index = geometry.index;
  const total = index ? index.count : position.count;
  const drawStart = Math.max(0, geometry.drawRange.start);
  const drawEnd = Math.min(total, geometry.drawRange.start + geometry.drawRange.count);
  // Con escala negativa el orden de los vértices se invierte: la cara delantera también.
  const flip = mesh.matrixWorld.determinant() < 0 ? -1 : 1;
  const vertexNormals = geometry.attributes.normal;
  _normalMatrix.getNormalMatrix(mesh.matrixWorld);

  const addRange = (start: number, end: number, material: Material | undefined): void => {
    if (!material) return;
    const side: Side = material.side;
    const triangles = Math.max(0, Math.ceil((end - start) / 3));
    tops.reserve(triangles);
    ceilings.reserve(triangles);
    for (let i = start; i + 2 < end; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      _a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
      _b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
      _c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
      _n.crossVectors(_ab.subVectors(_b, _a), _ac.subVectors(_c, _a)).multiplyScalar(flip);
      // Un rayo hacia abajo toca la cara delantera si la normal apunta hacia arriba (como el raycast de Three).
      if (_n.y === 0) continue; // vertical (paredes): no tiene huella en planta
      if (side !== DoubleSide && side !== FrontSide && side !== BackSide) continue;
      if ((side === FrontSide && _n.y < 0) || (side === BackSide && _n.y > 0)) {
        // Se ve desde abajo: un techo (o la cara de abajo de un bloque).
        const o = ceilings.count++ * 9;
        _a.toArray(ceilings.vertices, o);
        _b.toArray(ceilings.vertices, o + 3);
        _c.toArray(ceilings.vertices, o + 6);
        continue;
      }
      const { vertices, normals } = tops;
      tops.twoSided[tops.count] = side === DoubleSide ? 1 : 0;
      const o = tops.count++ * 9;
      _a.toArray(vertices, o);
      _b.toArray(vertices, o + 3);
      _c.toArray(vertices, o + 6);
      if (vertexNormals) {
        // Sin normalizar: la interpolación es lineal y se normaliza al consultar.
        _n.fromBufferAttribute(vertexNormals, ia).applyMatrix3(_normalMatrix).toArray(normals, o);
        _n.fromBufferAttribute(vertexNormals, ib).applyMatrix3(_normalMatrix).toArray(normals, o + 3);
        _n.fromBufferAttribute(vertexNormals, ic).applyMatrix3(_normalMatrix).toArray(normals, o + 6);
      } else {
        _n.normalize();
        _n.toArray(normals, o);
        _n.toArray(normals, o + 3);
        _n.toArray(normals, o + 6);
      }
    }
  };

  const material = mesh.material;
  if (Array.isArray(material)) {
    for (const group of geometry.groups) {
      addRange(Math.max(group.start, drawStart), Math.min(group.start + group.count, drawEnd), material[group.materialIndex ?? 0]);
    }
  } else {
    addRange(drawStart, drawEnd, material);
  }
}
