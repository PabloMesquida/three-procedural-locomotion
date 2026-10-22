import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { Bone, type Group, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  estimateForward,
  type HumanRigMapping,
  mapHumanRig,
  measureLegLength,
  mixamoMapping,
  RigMappingError,
} from '../src/index.ts';
// Prueban el mapper con el modelo de Mixamo de los tests aunque se pase otro con PH_MODEL.
const MODEL_PATH = 'modelos/human_mix_propio.glb';
import { loadSkeleton } from './helpers/skeleton.ts';

/** El mismo .glb cargado con el GLTFLoader de Three (funciona en Node con modelos sin texturas). */
function loadWithGLTFLoader(path: string): Promise<Group> {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject));
}

/** Posición world de cada bone, por nombre. */
function bonePositions(root: Object3D): Map<string, Vector3> {
  root.updateMatrixWorld(true);
  const out = new Map<string, Vector3>();
  root.traverse((o) => {
    if (o instanceof Bone) out.set(o.name, o.getWorldPosition(new Vector3()));
  });
  return out;
}

describe('rig: esqueleto y mapping', () => {
  it('lee el esqueleto del .glb igual que GLTFLoader (mismos bones, en la misma pose)', async () => {
    const ours = bonePositions(loadSkeleton(MODEL_PATH));
    const reference = bonePositions(await loadWithGLTFLoader(MODEL_PATH));
    assert.deepEqual([...ours.keys()].sort(), [...reference.keys()].sort());
    for (const [name, position] of ours) {
      const d = position.distanceTo(reference.get(name)!);
      assert.ok(d < 1e-9, `${name}: ${d} m`);
    }
  });

  it('el mapping de Mixamo encuentra todos los bones del modelo, sin avisos (salvo dedos que el rig no tenga)', () => {
    const { warnings } = mapHumanRig(loadSkeleton(MODEL_PATH), mixamoMapping);
    // Mixamo puede rigear con menos dedos (p. ej. 3: pulgar, índice y anular): eso solo avisa.
    assert.deepEqual(warnings.filter((w) => !w.includes('finger')), []);
  });

  it('estima que el modelo mira hacia +Z (la convención de glTF)', () => {
    const { rig } = mapHumanRig(loadSkeleton(MODEL_PATH), mixamoMapping);
    const forward = estimateForward(rig, 'toes');
    assert.ok(forward.z > 0.99, `forward = ${forward.toArray()}`);
  });

  it('falla con un error claro si falta un bone obligatorio', () => {
    const broken: HumanRigMapping = { ...mixamoMapping, left: { ...mixamoMapping.left, shin: 'noExiste' } };
    assert.throws(() => mapHumanRig(loadSkeleton(MODEL_PATH), broken), (e: unknown) => {
      assert.ok(e instanceof RigMappingError);
      assert.match(e.problems.join('\n'), /noExiste/);
      return true;
    });
  });

  it('detecta una cadena de pierna rota (tibia que no es hija del muslo)', () => {
    const model = loadSkeleton(MODEL_PATH);
    const shin = model.getObjectByName('mixamorigLeftLeg')!;
    const holder = new Object3D();
    shin.parent!.add(holder);
    holder.add(shin);
    assert.throws(() => mapHumanRig(model, mixamoMapping), RigMappingError);
  });

  it('el largo de pierna escala con el modelo', () => {
    const full = measureLegLength(mapHumanRig(loadSkeleton(MODEL_PATH), mixamoMapping).rig);
    const model = loadSkeleton(MODEL_PATH);
    model.scale.setScalar(0.5);
    const { rig } = mapHumanRig(model, mixamoMapping);
    assert.ok(Math.abs(measureLegLength(rig) - full * 0.5) < 1e-12);
  });

  it('dedos opcionales: usa las falanges que encuentra desde la base e ignora un dedo sin base', () => {
    const arm = mixamoMapping.rightArm!;
    // El anular: lo tienen los rigs de Mixamo de 5 y de 3 dedos.
    const ring = arm.fingers!.ring!;
    const mapping: HumanRigMapping = {
      ...mixamoMapping,
      rightArm: { ...arm, fingers: { ...arm.fingers, index: ['noExiste', 'tampoco', 'nada'], ring: [ring[0], ring[1], 'noExiste'] } },
    };
    const { rig, warnings } = mapHumanRig(loadSkeleton(MODEL_PATH), mapping);
    assert.equal(rig.rightArm!.fingers!.index, undefined);
    assert.equal(rig.rightArm!.fingers!.ring!.length, 2);
    assert.ok(warnings.some((w) => w.includes('finger index')), warnings.join(' | '));
  });
});
