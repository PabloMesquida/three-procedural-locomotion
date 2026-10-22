import {
  ArrowHelper,
  type Bone,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

import { estimateForward, type HumanRig, type LegBones } from '../rig/HumanRig.ts';

const LEFT_COLOR = 0x4fc3f7;
const RIGHT_COLOR = 0xffb74d;
const CENTER_COLOR = 0xffffff;

/**
 * Markers on the bones of the mapped rig: hips, and per leg thigh (hip joint), knee, ankle and toes.
 * Plus an arrow with the estimated "forward" direction.
 * They are drawn on top of the mesh.
 */
export class RigDebug {
  readonly group = new Group();

  private readonly markers: { bone: Bone; mesh: Mesh }[] = [];
  private readonly forwardArrow: ArrowHelper;
  private readonly rig: HumanRig;
  private readonly tmp = new Vector3();

  constructor(rig: HumanRig, radius = 0.02) {
    this.rig = rig;
    this.group.name = 'RigDebug';
    const geometry = new SphereGeometry(radius, 12, 8);

    const add = (bone: Bone | undefined, color: number, scale = 1): void => {
      if (!bone) return;
      const material = new MeshBasicMaterial({ color, depthTest: false, transparent: true });
      const mesh = new Mesh(geometry, material);
      mesh.scale.setScalar(scale);
      mesh.renderOrder = 999;
      this.group.add(mesh);
      this.markers.push({ bone, mesh });
    };

    const addLeg = (leg: LegBones, color: number): void => {
      add(leg.thigh, color);
      add(leg.shin, color, 1.2);
      add(leg.foot, color);
      add(leg.toe, color, 0.7);
    };

    add(rig.hips, CENTER_COLOR, 1.3);
    addLeg(rig.left, LEFT_COLOR);
    addLeg(rig.right, RIGHT_COLOR);

    this.forwardArrow = new ArrowHelper(new Vector3(0, 0, 1), new Vector3(), 0.5, 0x66ff66);
    this.group.add(this.forwardArrow);

    this.update();
  }

  /** Syncs the markers with the current pose of the bones. */
  update(): void {
    for (const { bone, mesh } of this.markers) bone.getWorldPosition(mesh.position);

    const source = this.rig.left.toe && this.rig.right.toe ? 'toes' : 'lateral';
    this.forwardArrow.setDirection(estimateForward(this.rig, source, this.tmp));
    this.rig.hips.getWorldPosition(this.forwardArrow.position);
    this.forwardArrow.position.y = 0.01;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }
}
