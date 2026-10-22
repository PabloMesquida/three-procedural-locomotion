import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OctahedronGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

import type { LegBones } from '../rig/HumanRig.ts';

const TARGET_COLOR = 0xff5252;
const POLE_COLOR = 0xe040fb;

/**
 * Shows a leg IK chain:
 *  - target (red octahedron) and pole target (magenta sphere)
 *  - line hip → knee → ankle (color of the leg)
 *  - line knee → pole
 * The target/pole positions are read from two external Object3D (the "handles").
 */
export class IKDebug {
  readonly group = new Group();

  private readonly leg: LegBones;
  private readonly target: Object3D;
  private readonly pole: Object3D;
  private readonly targetMesh: Mesh;
  private readonly poleMesh: Mesh;
  private readonly chainPositions = new BufferAttribute(new Float32Array(9), 3);
  private readonly polePositions = new BufferAttribute(new Float32Array(6), 3);
  private readonly hip = new Vector3();
  private readonly knee = new Vector3();
  private readonly ankle = new Vector3();

  constructor(leg: LegBones, target: Object3D, pole: Object3D, legColor: number) {
    this.leg = leg;
    this.target = target;
    this.pole = pole;
    this.group.name = 'IKDebug';

    const overlay = { depthTest: false, transparent: true } as const;

    this.targetMesh = new Mesh(
      new OctahedronGeometry(0.035),
      new MeshBasicMaterial({ color: TARGET_COLOR, wireframe: true, ...overlay }),
    );
    this.poleMesh = new Mesh(
      new SphereGeometry(0.025, 12, 8),
      new MeshBasicMaterial({ color: POLE_COLOR, ...overlay }),
    );

    const chainGeometry = new BufferGeometry().setAttribute('position', this.chainPositions);
    const chainLine = new Line(chainGeometry, new LineBasicMaterial({ color: legColor, ...overlay }));

    const poleGeometry = new BufferGeometry().setAttribute('position', this.polePositions);
    const poleLine = new Line(
      poleGeometry,
      new LineBasicMaterial({ color: POLE_COLOR, opacity: 0.5, ...overlay }),
    );

    for (const obj of [this.targetMesh, this.poleMesh, chainLine, poleLine]) {
      obj.renderOrder = 998;
      obj.frustumCulled = false;
      this.group.add(obj);
    }

    this.update();
  }

  update(): void {
    this.target.getWorldPosition(this.targetMesh.position);
    this.pole.getWorldPosition(this.poleMesh.position);

    const { hip, knee, ankle } = this;
    this.leg.thigh.getWorldPosition(hip);
    this.leg.shin.getWorldPosition(knee);
    this.leg.foot.getWorldPosition(ankle);

    this.chainPositions.setXYZ(0, hip.x, hip.y, hip.z);
    this.chainPositions.setXYZ(1, knee.x, knee.y, knee.z);
    this.chainPositions.setXYZ(2, ankle.x, ankle.y, ankle.z);
    this.chainPositions.needsUpdate = true;

    const p = this.poleMesh.position;
    this.polePositions.setXYZ(0, knee.x, knee.y, knee.z);
    this.polePositions.setXYZ(1, p.x, p.y, p.z);
    this.polePositions.needsUpdate = true;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }
}
