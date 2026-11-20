import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';

import type { ProceduralHuman } from '../ProceduralHuman.ts';

/** Options of `NavigationDebug`. */
export interface NavigationDebugOptions {
  /** Color of the ring and the line (default `0x66ff99`). */
  color?: number;
  /**
   * Also draw the line when it goes in a straight line (no planned route): from the feet to the destination.
   * Default `false`: the line only appears when there is a planned route.
   */
  straightLine?: boolean;
  /** Most points of the line (size of its buffer; default 256). A longer route is drawn up to there. */
  maxPoints?: number;
}

/** Height of the ring and of the line above the ground (m), so they don't fight with it. */
const RING_LIFT = 0.01;
const LINE_LIFT = 0.02;

/**
 * Shows the navigation of a character (`moveTo` / `followPath`):
 *  - flat ring: the destination (`moveTarget`), while it has one
 *  - line: from its feet along what is left of the planned route (`movePath`); with `straightLine`, also
 *    straight to the destination when there is no route
 *
 * It reads the state of `human.navigation` without copying it (no allocations per frame) and draws over everything
 * (`depthTest: false`). Call `update()` after `human.update(dt)`.
 */
export class NavigationDebug {
  readonly group = new Group();

  private readonly human: ProceduralHuman;
  private readonly straightLine: boolean;
  private readonly maxPoints: number;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly line: Line<BufferGeometry, LineBasicMaterial>;
  private readonly positions: BufferAttribute;

  constructor(human: ProceduralHuman, options: NavigationDebugOptions = {}) {
    this.human = human;
    this.straightLine = options.straightLine ?? false;
    this.maxPoints = Math.max(2, Math.floor(options.maxPoints ?? 256));
    const color = options.color ?? 0x66ff99;
    this.group.name = 'NavigationDebug';

    this.ring = new Mesh(
      new RingGeometry(0.12, 0.17, 32).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.ring.renderOrder = 10;
    this.ring.visible = false;

    this.positions = new BufferAttribute(new Float32Array(this.maxPoints * 3), 3);
    this.line = new Line(
      new BufferGeometry().setAttribute('position', this.positions),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false }),
    );
    this.line.renderOrder = 10;
    this.line.frustumCulled = false;
    this.line.visible = false;

    this.group.add(this.ring, this.line);
    this.update();
  }

  update(): void {
    const navigation = this.human.navigation;
    const target = navigation.active ? navigation.target : null;
    this.ring.visible = target !== null;
    if (target) this.ring.position.set(target.x, target.y + RING_LIFT, target.z);

    // La línea: desde los pies (la altura del suelo bajo el cuerpo), por lo que queda de la ruta; sin ruta, recta
    // hasta el destino si se pidió.
    const route = target ? navigation.path : null;
    const left = route ? route.length - navigation.pathIndex : 0;
    const planned = left > 0;
    this.line.visible = target !== null && (planned || this.straightLine);
    if (!this.line.visible || !target) return;
    const p = this.human.position;
    const ground = this.human.locomotion.body.state.groundHeight;
    this.positions.setXYZ(0, p.x, ground + LINE_LIFT, p.z);
    let count = 1;
    if (planned && route) {
      for (let i = navigation.pathIndex; i < route.length && count < this.maxPoints; i++, count++) {
        const q = route[i];
        this.positions.setXYZ(count, q.x, q.y + LINE_LIFT, q.z);
      }
    } else {
      this.positions.setXYZ(count++, target.x, target.y + LINE_LIFT, target.z);
    }
    this.positions.needsUpdate = true;
    this.line.geometry.setDrawRange(0, count);
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  /** Frees the geometries and materials (remove `group` from the scene first). */
  dispose(): void {
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.line.geometry.dispose();
    this.line.material.dispose();
  }
}
