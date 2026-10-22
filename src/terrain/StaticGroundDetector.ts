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

import type { GroundDetector, GroundHit } from './GroundDetector.ts';

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
 * scales.
 *
 * It is a snapshot: if the ground moves or changes, call `rebuild()` (for ground that moves every frame,
 * use `RaycastGroundDetector`). One detector serves all the characters in the scene.
 * Regular meshes only: InstancedMesh, SkinnedMesh and BatchedMesh are ignored (with a warning).
 */
export class StaticGroundDetector implements GroundDetector {
  /** Objects considered ground (traversed recursively when building and in `rebuild`). */
  targets: Object3D[];

  /** World vertices of each triangle (9 numbers: a, b, c). */
  private vertices = new Float64Array(0);
  /**
   * World normals of the vertices of each triangle (9 numbers; without normals in the mesh, the face
   * normal ×3).
   */
  private normals = new Float64Array(0);
  /** Triangles in the order of the leaves. */
  private order = new Uint32Array(0);
  /** Per node: minX, maxX, minZ, maxZ, minY, maxY. */
  private bounds = new Float64Array(0);
  /**
   * Per node: leaf → [start in `order`, number of triangles]; internal → [right child, 0] (the left one is
   * the next node).
   */
  private nodes = new Int32Array(0);
  private readonly stack = new Int32Array(MAX_DEPTH * 2);
  private readonly layers = new Layers();

  constructor(targets: Object3D[]) {
    this.targets = targets;
    this.rebuild();
  }

  /** Indexed triangles (the ones a vertical ray can hit). */
  get triangleCount(): number {
    return this.order.length;
  }

  /** Reads the meshes in `targets` again (after moving them, changing them or changing the list). */
  rebuild(): void {
    const triangles = new TriangleBuffer();
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
        collectTriangles(mesh, triangles);
      });
    }
    if (unsupported.size > 0) {
      console.warn(`StaticGroundDetector: ${[...unsupported].join(', ')} not supported, ignored (use RaycastGroundDetector).`);
    }
    this.vertices = triangles.vertices.slice(0, triangles.count * 9);
    this.normals = triangles.normals.slice(0, triangles.count * 9);
    this.buildTree();
  }

  castDown(origin: Vector3, maxDistance: number, out: GroundHit): boolean {
    const { bounds, nodes, order, vertices: v, stack } = this;
    if (order.length === 0) return false;
    const x = origin.x;
    const z = origin.z;
    const top = origin.y;
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
      if (bounds[b + 4] > top || bounds[b + 5] < bottom || bounds[b + 5] <= bestY) continue;
      const count = nodes[node * 2 + 1];
      if (count === 0) {
        stack[sp++] = nodes[node * 2];
        stack[sp++] = node + 1;
        continue;
      }
      const start = nodes[node * 2];
      for (let i = start; i < start + count; i++) {
        const t = order[i];
        const o = t * 9;
        const ax = v[o], ay = v[o + 1], az = v[o + 2];
        const bx = v[o + 3], by = v[o + 4], bz = v[o + 5];
        const cx = v[o + 6], cy = v[o + 7], cz = v[o + 8];
        // Funciones de arista en planta: el punto está dentro si las tres tienen el signo del área.
        const wc = (bx - ax) * (z - az) - (bz - az) * (x - ax);
        const wa = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
        const wb = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
        const area = wa + wb + wc;
        const tolerance = -EDGE_EPSILON * Math.abs(area);
        if (area > 0 ? wa < tolerance || wb < tolerance || wc < tolerance : wa > -tolerance || wb > -tolerance || wc > -tolerance) continue;
        const y = (wa * ay + wb * by + wc * cy) / area;
        if (y > top || y < bottom || y <= bestY) continue;
        bestY = y;
        best = t;
      }
    }
    if (best < 0) return false;
    out.point.set(x, bestY, z);
    // Normal interpolada con las coordenadas baricéntricas del punto (como el raycast de Three).
    const o = best * 9;
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
    out.distance = top - bestY;
    return true;
  }

  /**
   * Tree built by splitting at the median of the longest axis (X or Z) of the centers, depth first.
   * Each leaf's box is that of its triangles and each internal node's, the union of its children.
   */
  private buildTree(): void {
    const n = this.vertices.length / 9;
    const v = this.vertices;
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
    this.order = order;
    this.bounds = bounds.slice(0, nodeCount * 6);
    this.nodes = nodes.slice(0, nodeCount * 2);
  }
}

/** Expands the box `target[t..t+6)` (minX, maxX, minZ, maxZ, minY, maxY) with `source[s..s+6)`. */
function unionBounds(target: Float64Array, t: number, source: Float64Array, s: number): void {
  for (let k = 0; k < 6; k += 2) {
    if (source[s + k] < target[t + k]) target[t + k] = source[s + k];
    if (source[s + k + 1] > target[t + k + 1]) target[t + k + 1] = source[s + k + 1];
  }
}

/** Vertices and normals of the collected triangles (9 numbers per triangle each), with growing capacity. */
class TriangleBuffer {
  count = 0;
  vertices = new Float64Array(9 * 1024);
  normals = new Float64Array(9 * 1024);

  /** Makes room for `extra` more triangles. */
  reserve(extra: number): void {
    const needed = (this.count + extra) * 9;
    if (needed <= this.vertices.length) return;
    const size = Math.max(needed, this.vertices.length * 2);
    const vertices = new Float64Array(size);
    vertices.set(this.vertices);
    const normals = new Float64Array(size);
    normals.set(this.normals);
    this.vertices = vertices;
    this.normals = normals;
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

/** Adds the triangles of `mesh` that a vertical ray downwards can hit (as its raycast would). */
function collectTriangles(mesh: Mesh, out: TriangleBuffer): void {
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
    out.reserve(Math.max(0, Math.ceil((end - start) / 3)));
    const { vertices, normals } = out;
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
      if (side === FrontSide && _n.y < 0) continue;
      if (side === BackSide && _n.y > 0) continue;
      if (side !== DoubleSide && side !== FrontSide && side !== BackSide) continue;
      const o = out.count++ * 9;
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
