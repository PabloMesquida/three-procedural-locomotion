import { readFileSync } from 'node:fs';

import { Bone, Group, Matrix4, Object3D, PropertyBinding } from 'three';

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfJson {
  scene?: number;
  scenes: { name?: string; nodes: number[] }[];
  nodes: GltfNode[];
  skins?: { joints: number[] }[];
}

/**
 * Lee de un .glb solo la jerarquía de nodos (nombres y transformaciones) y la
 * reconstruye como lo hace GLTFLoader: los joints de las skins son `Bone`, el
 * resto `Object3D`, y los nombres se sanean igual (`mixamorig:Hips` → `mixamorigHips`).
 *
 * Así los tests corren en Node, sin navegador, sin mallas ni texturas: la
 * locomoción solo usa los huesos.
 */
export function loadSkeleton(path: string): Group {
  const buffer = readFileSync(path);
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} no es un archivo .glb`);
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${path}: el primer bloque del .glb no es JSON`);
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength)) as GltfJson;

  const joints = new Set((json.skins ?? []).flatMap((skin) => skin.joints));
  const usedNames = new Map<string, number>();
  const uniqueName = (original: string | undefined): string => {
    const name = PropertyBinding.sanitizeNodeName(original ?? '');
    const count = usedNames.get(name) ?? 0;
    usedNames.set(name, count + 1);
    return count === 0 ? name : `${name}_${count}`;
  };

  const build = (index: number): Object3D => {
    const def = json.nodes[index];
    const node = joints.has(index) ? new Bone() : new Object3D();
    node.name = def.name ? uniqueName(def.name) : '';
    if (def.matrix) {
      node.applyMatrix4(new Matrix4().fromArray(def.matrix));
    } else {
      if (def.translation) node.position.fromArray(def.translation);
      if (def.rotation) node.quaternion.fromArray(def.rotation);
      if (def.scale) node.scale.fromArray(def.scale);
    }
    for (const child of def.children ?? []) node.add(build(child));
    return node;
  };

  const sceneDef = json.scenes[json.scene ?? 0];
  const scene = new Group();
  scene.name = sceneDef.name ? uniqueName(sceneDef.name) : '';
  for (const index of sceneDef.nodes) scene.add(build(index));
  scene.updateMatrixWorld(true);
  return scene;
}
