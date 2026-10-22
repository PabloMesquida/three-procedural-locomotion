import {
  BoxGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
} from 'three';

export type TerrainKind = 'flat' | 'slopeSide' | 'slopeFront' | 'bumpy';

export const terrainLabels: Record<TerrainKind, string> = {
  flat: 'Plano',
  slopeSide: 'Pendiente lateral (15°)',
  slopeFront: 'Pendiente frontal (15°)',
  bumpy: 'Irregular (baches, escalón, piedra)',
};

const SLOPE_DEG = 15;
const material = new MeshStandardMaterial({ color: 0x3a3d44 });
const propMaterial = new MeshStandardMaterial({ color: 0x5a5148, flatShading: true });

/** Baches suaves de unos ±5 cm. */
function bumpHeight(x: number, z: number): number {
  return (
    0.03 * Math.sin((2 * Math.PI * x) / 0.9) * Math.cos((2 * Math.PI * z) / 1.1) +
    0.02 * Math.sin((2 * Math.PI * (x + 0.7 * z)) / 0.5)
  );
}

function makeBumpyGround(width: number, length: number, cell: number): Mesh {
  const geometry = new PlaneGeometry(width, length, Math.round(width / cell), Math.round(length / cell));
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, bumpHeight(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();
  return new Mesh(geometry, material);
}

function makePlane(size: number): Mesh {
  const plane = new Mesh(new PlaneGeometry(size, size), material);
  plane.rotation.x = -Math.PI / 2;
  return plane;
}

/** Distancia máxima que el personaje puede recorrer desde el origen sin salirse del terreno (m). */
export function terrainHalfExtent(kind: TerrainKind): number {
  switch (kind) {
    case 'flat':
      return 45;
    case 'slopeSide':
    case 'slopeFront':
      return 8;
    case 'bumpy':
      return 7;
  }
}

/** Terrenos de prueba para el foot placement. Todos pasan por y = 0 en el origen. */
export function createTerrain(kind: TerrainKind): Group {
  const group = new Group();
  group.name = `terrain-${kind}`;

  switch (kind) {
    case 'flat':
      group.add(makePlane(100));
      break;

    case 'slopeSide': // sube hacia +X
      group.add(makePlane(20));
      group.rotation.z = MathUtils.degToRad(SLOPE_DEG);
      break;

    case 'slopeFront': // sube hacia -Z (delante del personaje)
      group.add(makePlane(20));
      group.rotation.x = MathUtils.degToRad(SLOPE_DEG);
      break;

    case 'bumpy': {
      // Pista de 5 × 16 m a lo largo de Z (la dirección de avance del modelo).
      // Celdas de ~8 cm: suficiente para los baches y barato de raycastear.
      const ground = makeBumpyGround(5, 16, 0.083);
      group.add(ground);

      // Escalón de ~8 cm a la derecha del personaje (+X).
      const step = new Mesh(new BoxGeometry(0.7, 0.13, 1.4), propMaterial);
      step.position.set(1.3, 0.015, 0);
      group.add(step);

      // Piedra baja (esfera escalada de forma no uniforme) a la izquierda (−X).
      const rock = new Mesh(new SphereGeometry(1, 12, 8), propMaterial);
      rock.scale.set(0.28, 0.07, 0.3);
      rock.position.set(-1.2, 0, 0.05);
      group.add(rock);

      // En el recorrido hacia delante (−Z): un escalón que cruza la pista y una piedra.
      const crossStep = new Mesh(new BoxGeometry(1.6, 0.12, 0.6), propMaterial);
      crossStep.position.set(0, 0.0, -3);
      group.add(crossStep);

      const pathRock = new Mesh(new SphereGeometry(1, 12, 8), propMaterial);
      pathRock.scale.set(0.2, 0.08, 0.25);
      pathRock.position.set(-0.12, 0, -5.5);
      group.add(pathRock);
      break;
    }
  }

  group.updateMatrixWorld(true);
  return group;
}
