import {
  ArrowHelper,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

import { evaluateSwing } from '../locomotion/FootTarget.ts';
import type { LocomotionController } from '../locomotion/LocomotionController.ts';
import type { Side } from '../rig/HumanRig.ts';

const COLORS: Record<Side, number> = { left: 0x4fc3f7, right: 0xffb74d };
const ARC_SAMPLES = 16;

interface FootVisuals {
  home: Mesh;
  landing: Mesh;
  arc: Line;
  arcPositions: BufferAttribute;
}

/**
 * Shows the locomotion:
 *  - ring: neutral (home) position of each foot
 *  - octahedron: landing point of the current step
 *  - line: swing trajectory
 *  - green arrow: velocity of the body
 *  - white sphere: projection of the center of mass on the ground
 *  - magenta diamond: center of support (feet weighted by their load)
 */
export class LocomotionDebug {
  readonly group = new Group();

  private readonly controller: LocomotionController;
  private readonly visuals: Record<Side, FootVisuals>;
  private readonly velocityArrow: ArrowHelper;
  private readonly comMarker: Mesh;
  private readonly supportMarker: Mesh;
  private readonly comLinePositions = new BufferAttribute(new Float32Array(6), 3);
  private readonly p = new Vector3();
  private readonly q = new Quaternion();

  constructor(controller: LocomotionController) {
    this.controller = controller;
    this.group.name = 'LocomotionDebug';
    const overlay = { depthTest: false, transparent: true } as const;

    const make = (side: Side): FootVisuals => {
      const color = COLORS[side];
      const home = new Mesh(
        new RingGeometry(0.04, 0.055, 24).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color, side: DoubleSide, ...overlay }),
      );
      const landing = new Mesh(
        new OctahedronGeometry(0.035),
        new MeshBasicMaterial({ color, wireframe: true, ...overlay }),
      );
      const arcPositions = new BufferAttribute(new Float32Array((ARC_SAMPLES + 1) * 3), 3);
      const arc = new Line(
        new BufferGeometry().setAttribute('position', arcPositions),
        new LineBasicMaterial({ color, opacity: 0.7, ...overlay }),
      );
      arc.frustumCulled = false;
      for (const obj of [home, landing, arc]) {
        obj.renderOrder = 996;
        this.group.add(obj);
      }
      return { home, landing, arc, arcPositions };
    };
    this.visuals = { left: make('left'), right: make('right') };

    this.velocityArrow = new ArrowHelper(new Vector3(0, 0, -1), new Vector3(), 0.5, 0x66ff66);
    this.group.add(this.velocityArrow);

    this.comMarker = new Mesh(new SphereGeometry(0.025, 12, 8), new MeshBasicMaterial({ color: 0xffffff, ...overlay }));
    this.supportMarker = new Mesh(
      new OctahedronGeometry(0.03).scale(1, 0.4, 1),
      new MeshBasicMaterial({ color: 0xe040fb, ...overlay }),
    );
    const comLine = new Line(
      new BufferGeometry().setAttribute('position', this.comLinePositions),
      new LineBasicMaterial({ color: 0xffffff, opacity: 0.6, ...overlay }),
    );
    comLine.frustumCulled = false;
    for (const obj of [this.comMarker, this.supportMarker, comLine]) {
      obj.renderOrder = 996;
      this.group.add(obj);
    }
    this.update();
  }

  update(): void {
    const c = this.controller;
    for (const side of ['left', 'right'] as const) {
      const v = this.visuals[side];
      const foot = c.feet[side];
      c.planner.homePosition(side, v.home.position);

      const airborne = c.body.state.airborne;
      const swinging = foot.phase === 'SWING' && !airborne;
      v.landing.visible = swinging || airborne;
      v.arc.visible = swinging;
      if (swinging || airborne) v.landing.position.copy(foot.swing.landing);
      if (swinging) {
        for (let i = 0; i <= ARC_SAMPLES; i++) {
          evaluateSwing(foot.swing, i / ARC_SAMPLES, foot.swing.height, this.p, this.q);
          v.arcPositions.setXYZ(i, this.p.x, this.p.y, this.p.z);
        }
        v.arcPositions.needsUpdate = true;
      }
    }

    const body = c.body.state;
    this.comMarker.position.set(body.com.x, body.position.y + 0.01, body.com.z);
    this.supportMarker.position.copy(body.supportCenter).setY(body.supportCenter.y + 0.01);
    this.comLinePositions.setXYZ(0, body.com.x, body.com.y, body.com.z);
    this.comLinePositions.setXYZ(1, body.com.x, body.position.y + 0.01, body.com.z);
    this.comLinePositions.needsUpdate = true;

    const speed = c.velocity.length();
    this.velocityArrow.visible = speed > 1e-3;
    if (speed > 1e-3) {
      this.velocityArrow.setDirection(this.p.copy(c.velocity).divideScalar(speed));
      this.velocityArrow.setLength(0.3 + speed * 0.5, 0.08, 0.05);
      c.planner.homePosition('left', this.velocityArrow.position);
      c.planner.homePosition('right', this.p);
      this.velocityArrow.position.add(this.p).multiplyScalar(0.5);
    }
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }
}
