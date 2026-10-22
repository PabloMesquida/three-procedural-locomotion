import {
  ArrowHelper,
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

import type { FootGroundState } from '../terrain/FootPlacement.ts';

const RAY_HIT = 0x7cff7c;
const RAY_MISS = 0xff5252;
const NORMAL_COLOR = 0xffeb3b;
const TOE_USED = 0x40c4ff;
const TARGET_COLOR = 0xff5252;

/**
 * Shows the foot placement of one foot:
 *  - raycast under the heel (green if it finds ground, red if not)
 *  - raycast under the toes (green, or blue if it was used to tilt the foot)
 *  - hit point and ground normal (yellow arrow)
 *  - ankle target (red octahedron)
 */
export class FootDebug {
  readonly group = new Group();

  private readonly state: FootGroundState;
  private readonly rayPositions = new BufferAttribute(new Float32Array(6), 3);
  private readonly rayMaterial = new LineBasicMaterial({ color: RAY_HIT, depthTest: false, transparent: true });
  private readonly toeRayPositions = new BufferAttribute(new Float32Array(6), 3);
  private readonly toeRayMaterial = new LineBasicMaterial({ color: RAY_HIT, depthTest: false, transparent: true });
  private readonly toeHitMesh: Mesh;
  private readonly hitMesh: Mesh;
  private readonly targetMesh: Mesh;
  private readonly normalArrow: ArrowHelper;

  constructor(state: FootGroundState) {
    this.state = state;
    this.group.name = 'FootDebug';
    const overlay = { depthTest: false, transparent: true } as const;

    const ray = new Line(new BufferGeometry().setAttribute('position', this.rayPositions), this.rayMaterial);
    ray.frustumCulled = false;
    const toeRay = new Line(
      new BufferGeometry().setAttribute('position', this.toeRayPositions),
      this.toeRayMaterial,
    );
    toeRay.frustumCulled = false;

    this.hitMesh = new Mesh(new SphereGeometry(0.012, 8, 6), new MeshBasicMaterial({ color: RAY_HIT, ...overlay }));
    this.toeHitMesh = new Mesh(this.hitMesh.geometry, new MeshBasicMaterial({ color: RAY_HIT, ...overlay }));
    this.targetMesh = new Mesh(
      new OctahedronGeometry(0.03),
      new MeshBasicMaterial({ color: TARGET_COLOR, wireframe: true, ...overlay }),
    );
    this.normalArrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 0.15, NORMAL_COLOR, 0.04, 0.025);

    for (const obj of [ray, toeRay, this.hitMesh, this.toeHitMesh, this.targetMesh, this.normalArrow]) {
      obj.renderOrder = 997;
      this.group.add(obj);
    }
    this.update();
  }

  update(): void {
    const s = this.state;
    const end = s.grounded ? s.hit.point : s.rayEnd;
    this.rayPositions.setXYZ(0, s.rayOrigin.x, s.rayOrigin.y, s.rayOrigin.z);
    this.rayPositions.setXYZ(1, end.x, end.y, end.z);
    this.rayPositions.needsUpdate = true;
    this.rayMaterial.color.setHex(s.grounded ? RAY_HIT : RAY_MISS);

    this.hitMesh.visible = s.grounded;
    this.normalArrow.visible = s.grounded;
    this.hitMesh.position.copy(s.hit.point);
    this.normalArrow.position.copy(s.hit.point);
    this.normalArrow.setDirection(s.hit.normal);

    const toeEnd = s.toeGrounded ? s.toeHit.point : s.toeRayEnd;
    this.toeRayPositions.setXYZ(0, s.toeRayOrigin.x, s.toeRayOrigin.y, s.toeRayOrigin.z);
    this.toeRayPositions.setXYZ(1, toeEnd.x, toeEnd.y, toeEnd.z);
    this.toeRayPositions.needsUpdate = true;
    const toeColor = !s.toeGrounded ? RAY_MISS : s.usedToe ? TOE_USED : RAY_HIT;
    this.toeRayMaterial.color.setHex(toeColor);
    (this.toeHitMesh.material as MeshBasicMaterial).color.setHex(toeColor);
    this.toeHitMesh.visible = s.toeGrounded;
    this.toeHitMesh.position.copy(s.toeHit.point);

    this.targetMesh.position.copy(s.ankleTarget);
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }
}
