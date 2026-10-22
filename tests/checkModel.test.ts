import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Object3D, Scene, Vector3 } from 'three';

import { createTerrain } from './helpers/terrains.ts';
import { checkModel, createProceduralHuman, type HumanRigMapping, mapHumanRig } from '../src/index.ts';
import { type Proportions, PROPORTION_VARIANTS, reshape } from './helpers/proportions.ts';
import { DEG, MODEL_MAPPING, MODEL_PATH } from './helpers/sim.ts';
import { loadSkeleton } from './helpers/skeleton.ts';

/** Avisos del modelo de los tests después de `change` (sobre el esqueleto recién cargado). */
function warningsAfter(change: (model: Object3D) => void = () => {}): string[] {
  const model = loadSkeleton(MODEL_PATH);
  change(model);
  model.updateMatrixWorld(true);
  return checkModel(mapHumanRig(model, MODEL_MAPPING).rig);
}

const rigOf = (model: Object3D) => {
  model.updateMatrixWorld(true);
  return mapHumanRig(model, MODEL_MAPPING).rig;
};

/** Exige exactamente un tipo de aviso (o más del mismo tipo, uno por pierna), que contenga `text`. */
function expectOnly(warnings: string[], text: string): void {
  assert.ok(warnings.length > 0 && warnings.every((w) => w.includes(text)), `se esperaba solo "${text}": ${JSON.stringify(warnings)}`);
}

/** Exige un aviso que contenga `text` (el problema puede traer otros: una rodilla doblada levanta los dedos). */
function expectSome(warnings: string[], text: string): void {
  assert.ok(warnings.some((w) => w.includes(text)), `se esperaba "${text}": ${JSON.stringify(warnings)}`);
}

describe('comprobación del modelo (checkModel, human.warnings)', () => {
  it('el modelo de los tests no da avisos', () => {
    assert.deepEqual(warningsAfter(), []);
  });

  it('las proporciones que prueban los tests no dan avisos (los límites las incluyen)', () => {
    for (const [name, proportions] of Object.entries(PROPORTION_VARIANTS)) {
      assert.deepEqual(warningsAfter(reshape(proportions)), [], name);
    }
  });

  it('modelo en centímetros', () => {
    expectOnly(warningsAfter((m) => m.scale.setScalar(100)), 'in meters');
  });

  it('rodilla doblada en la pose de reposo', () => {
    expectSome(warningsAfter((m) => rigOf(m).left.shin.rotateX(40 * DEG)), 'Left knee bent');
  });

  it('modelo con el eje Z hacia arriba (tumbado)', () => {
    const warnings = warningsAfter((m) => m.rotateX(-90 * DEG));
    assert.ok(warnings.some((w) => w.includes('Y axis up')), JSON.stringify(warnings));
  });

  it('origen que no está a la altura de las plantas (p. ej. en las caderas)', () => {
    const warnings = warningsAfter((m) => {
      const hipsHeight = rigOf(m).hips.getWorldPosition(new Vector3()).y;
      for (const child of m.children) child.position.y -= hipsHeight;
    });
    expectOnly(warnings, 'origin');
  });

  it('pies que no están planos en reposo', () => {
    // Los dedos 15 cm por encima del suelo (en world: no depende de los ejes de los bones del rig).
    expectOnly(warningsAfter((m) => {
      const toe = rigOf(m).right.toe!;
      toe.position.copy(toe.parent!.worldToLocal(toe.getWorldPosition(new Vector3()).add(new Vector3(0, 0.15, 0))));
    }), 'right foot');
  });

  it('piernas de distinto largo', () => {
    expectSome(warningsAfter((m) => rigOf(m).left.foot.position.multiplyScalar(1.3)), 'different lengths');
  });

  const proportion = (p: Proportions, text: string) => () => expectOnly(warningsAfter(reshape(p)), text);
  it('muslo mucho más largo que la tibia', proportion({ thigh: 1.6, shin: 0.75 }, 'Thigh / shin'));
  it('caderas muy anchas', proportion({ hips: 2.2 }, 'Hips'));
  it('pies muy largos', proportion({ feet: 2.2 }, 'Feet'));

  describe('dirección hacia delante', () => {
    const create = (mapping: HumanRigMapping, forward?: Vector3): readonly string[] => {
      const scene = new Scene();
      const ground = createTerrain('flat');
      scene.add(ground);
      const model = loadSkeleton(MODEL_PATH);
      scene.add(model);
      scene.updateMatrixWorld(true);
      return createProceduralHuman({ model, mapping, ground: [ground], forward }).warnings;
    };
    const noToes: HumanRigMapping = { ...MODEL_MAPPING, left: { ...MODEL_MAPPING.left, toe: undefined }, right: { ...MODEL_MAPPING.right, toe: undefined } };
    const forward = rigOf(loadSkeleton(MODEL_PATH)).left.toe!.getWorldPosition(new Vector3())
      .sub(rigOf(loadSkeleton(MODEL_PATH)).left.foot.getWorldPosition(new Vector3())).setY(0).normalize();

    it('sin dedos en el mapping hay que pasar forward', () => {
      assert.ok(create(noToes).some((w) => w.includes('pass `forward`')), JSON.stringify(create(noToes)));
      assert.ok(!create(noToes, forward).some((w) => w.includes('forward')));
    });

    it('un forward que contradice a los pies avisa', () => {
      assert.ok(!create(MODEL_MAPPING, forward).some((w) => w.includes('forward')));
      assert.ok(create(MODEL_MAPPING, forward.clone().negate()).some((w) => w.includes('`forward` is at')));
    });
  });
});
