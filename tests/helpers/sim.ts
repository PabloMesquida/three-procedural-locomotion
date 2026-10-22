import { type Object3D, Quaternion, Scene, Vector3 } from 'three';

import { createTerrain, type TerrainKind } from './terrains.ts';
import {
  createGroundHit,
  createProceduralHuman,
  type HumanRigMapping,
  mixamoMapping,
  estimateForward,
  mapHumanRig,
  measureLegLength,
  REFERENCE_LEG_LENGTH,
  rigifyMapping,
  type ProceduralHuman,
  type ProceduralHumanOptions,
  RaycastGroundDetector,
  type Side,
  StaticGroundDetector,
} from '../../src/index.ts';
import { loadSkeleton } from './skeleton.ts';

/** Modelo con el que se prueba (se puede cambiar con la variable de entorno PH_MODEL). */
const UP = new Vector3(0, 1, 0);
export const MODEL_PATH = process.env.PH_MODEL ?? 'modelos/human_mix_propio.glb';
/** Mapping del modelo de los tests: `PH_MAPPING=rigify` para un metarig de Rigify (por defecto, Mixamo). */
/** Con PH_GROUND=static, los personajes de los tests usan StaticGroundDetector en vez del raycast de Three. */
export const STATIC_GROUND = process.env.PH_GROUND === 'static';
export const MODEL_MAPPING: HumanRigMapping = process.env.PH_MAPPING === 'rigify' ? rigifyMapping : mixamoMapping;

/**
 * Los tests están escritos para un personaje que mira hacia −Z y cuyo largo de pierna es
 * REFERENCE_LEG_LENGTH (bodyScale 1). Cualquier modelo (el de los tests o PH_MODEL) se gira y escala
 * para que cumpla eso: así se prueban sus proporciones y su rig, no su orientación ni su tamaño
 * (eso lo prueban los tests de escala, de padres transformados y del rig).
 */
function normalizeModel(model: Object3D): void {
  model.updateMatrixWorld(true);
  const { rig } = mapHumanRig(model, MODEL_MAPPING);
  const forward = estimateForward(rig, rig.left.toe && rig.right.toe ? 'toes' : 'lateral');
  // Se transforman los hijos de la raíz (no la raíz), para que los tests puedan seguir moviendo,
  // girando o escalando la raíz del modelo.
  const turn = new Quaternion().setFromAxisAngle(UP, Math.PI - Math.atan2(forward.x, forward.z));
  const k = REFERENCE_LEG_LENGTH / measureLegLength(rig);
  for (const child of model.children) {
    child.position.applyQuaternion(turn).multiplyScalar(k);
    child.quaternion.premultiply(turn);
    child.scale.multiplyScalar(k);
  }
  model.updateMatrixWorld(true);
}
export const SIDES: readonly Side[] = ['left', 'right'];
export const DEG = Math.PI / 180;

export interface WorldOptions {
  /** Cambia el esqueleto recién cargado, antes de normalizarlo (p. ej. sus proporciones). */
  prepare?: (model: Object3D) => void;
  /** Mapping a usar en vez del del modelo de los tests (p. ej. con huesos añadidos en `prepare`). */
  mapping?: HumanRigMapping;
  terrain?: TerrainKind;
  /** Escala uniforme del terreno (para pruebas de semejanza). */
  terrainScale?: number;
  /** Escala uniforme del modelo. */
  modelScale?: number;
  /** Coloca el modelo en la escena (por defecto, hijo directo de la escena en el origen). */
  place?: (model: Object3D, scene: Scene) => void;
  /** Suelo con StaticGroundDetector (por defecto, según PH_GROUND) o con el raycast de Three. */
  staticGround?: boolean;
  /** Opciones del personaje (config, bodyScale…). */
  human?: Partial<Omit<ProceduralHumanOptions, 'model' | 'mapping' | 'ground'>>;
}

export interface World {
  scene: Scene;
  terrain: Object3D;
  model: Object3D;
  human: ProceduralHuman;
  /** Altura de la punta del pie sobre la planta en la pose de reposo (m), por pie. */
  restToeHeight: Record<Side, number>;
}

export function createWorld(options: WorldOptions = {}): World {
  const scene = new Scene();
  const terrain = createTerrain(options.terrain ?? 'flat');
  terrain.scale.setScalar(options.terrainScale ?? 1);
  scene.add(terrain);
  terrain.updateMatrixWorld(true);

  const model = loadSkeleton(MODEL_PATH);
  options.prepare?.(model);
  normalizeModel(model);
  model.scale.multiplyScalar(options.modelScale ?? 1);
  if (options.place) options.place(model, scene);
  else scene.add(model);
  scene.updateMatrixWorld(true);

  // Altura de reposo de la punta respecto a la raíz (que está en la planta de los pies), antes de ningún IK.
  const ground = (options.staticGround ?? STATIC_GROUND) ? new StaticGroundDetector([terrain]) : [terrain];
  const human = createProceduralHuman({ model, mapping: options.mapping ?? MODEL_MAPPING, ground, ...options.human });
  const toeY = (side: Side): number => (human.rig[side].toe?.getWorldPosition(new Vector3()).y ?? 0) - human.position.y;
  return { scene, terrain, model, human, restToeHeight: { left: toeY('left'), right: toeY('right') } };
}

/** Orden del guion: a partir de `t` segundos se ejecuta una vez. */
export type Step = [t: number, action: (human: ProceduralHuman) => void];

/**
 * Métricas de una simulación. Longitudes en metros salvo indicación.
 * Las medidas relativas al cuerpo se dividen por el largo de pierna.
 */
export class Recorder {
  /** Máximo desplazamiento de un pie apoyado entre dos frames (no debe deslizar). */
  slip = 0;
  /** Máximo error del IK en una pierna apoyada. */
  stanceIK = 0;
  /** Mínima holgura de la punta del pie sobre el terreno en el aire (respecto a la de reposo). */
  toeClearance = Number.POSITIVE_INFINITY;
  /** Mínimo desplazamiento vertical de las caderas / largo de pierna (negativo = abajo). */
  hipDrop = 0;
  /** Máximo cambio brusco de la velocidad vertical de las caderas (m/frame por frame), fuera del aire. */
  hipJerk = 0;
  /** Máximo cambio brusco de la velocidad de un pie (m/frame por frame), fuera del aire. */
  footJerk = 0;
  /** Despegues de los pies en orden: "LRLR…" ("|" = aterrizaje de un salto; no cuentan los despegues del salto). */
  liftoffs = '';
  /** Instantes en que el gait entra en idle. */
  idleTimes: number[] = [];
  maxSpeed = 0;
  /** Pasos (despegues) después de `markTime`. */
  liftoffsAfterMark = 0;
  markTime = Number.POSITIVE_INFINITY;
  frames = 0;
  finiteOK = true;

  private readonly human: ProceduralHuman;
  private readonly detector: RaycastGroundDetector;
  private readonly hit = createGroundHit();
  private readonly previousPhase: Record<Side, string>;
  private readonly lastPlanted: Record<Side, Vector3>;
  private readonly restToeHeight: Record<Side, number>;
  private readonly lastFoot: Record<Side, Vector3 | null> = { left: null, right: null };
  private readonly lastFootV: Record<Side, Vector3 | null> = { left: null, right: null };
  private lastHipY: number | null = null;
  private lastHipV: number | null = null;
  private lastMode: string;
  private lastJumpPhase = 'GROUNDED';
  private readonly v = new Vector3();

  constructor(world: World) {
    const { human, terrain } = world;
    this.human = human;
    this.detector = new RaycastGroundDetector([terrain]);
    const feet = human.locomotion.feet;
    this.previousPhase = { left: feet.left.phase, right: feet.right.phase };
    this.lastPlanted = { left: feet.left.planted.clone(), right: feet.right.planted.clone() };
    this.restToeHeight = world.restToeHeight;
    this.lastMode = human.gaitMode;
  }

  /** Altura de la punta del pie sobre el terreno bajo ella (m). */
  toeHeight(side: Side): number {
    const toe = this.human.rig[side].toe;
    if (!toe) return 0;
    toe.getWorldPosition(this.v);
    const y = this.v.y;
    this.v.y += 1;
    return this.detector.castDown(this.v, 3, this.hit) ? y - this.hit.point.y : Number.POSITIVE_INFINITY;
  }

  sample(time: number): void {
    const h = this.human;
    const loco = h.locomotion;
    const L = h.legLength;
    this.frames++;
    this.maxSpeed = Math.max(this.maxSpeed, h.speed);

    for (const side of SIDES) {
      const foot = loco.feet[side];
      if (foot.phase === 'SWING' && this.previousPhase[side] !== 'SWING' && !h.airborne) {
        this.liftoffs += side === 'left' ? 'L' : 'R';
        if (time >= this.markTime) this.liftoffsAfterMark++;
      }
      if (foot.phase !== 'SWING' && this.previousPhase[side] !== 'SWING') {
        this.slip = Math.max(this.slip, foot.planted.distanceTo(this.lastPlanted[side]));
      }
      if (foot.phase !== 'SWING') {
        this.lastPlanted[side].copy(foot.planted);
        this.stanceIK = Math.max(this.stanceIK, loco.ikError(side));
      } else if (!h.airborne) {
        this.toeClearance = Math.min(this.toeClearance, this.toeHeight(side) - this.restToeHeight[side]);
      }
      this.previousPhase[side] = foot.phase;

      const last = this.lastFoot[side];
      if (last) {
        const velocity = foot.position.clone().sub(last);
        const lastV = this.lastFootV[side];
        if (lastV && !h.airborne && h.jumpPhase === 'GROUNDED') this.footJerk = Math.max(this.footJerk, velocity.distanceTo(lastV));
        this.lastFootV[side] = velocity;
        last.copy(foot.position);
      } else {
        this.lastFoot[side] = foot.position.clone();
      }
    }

    this.hipDrop = Math.min(this.hipDrop, loco.pelvis.offset / L);
    const hipY = h.rig.hips.getWorldPosition(this.v).y;
    if (![hipY, h.position.x, h.position.z].every(Number.isFinite)) this.finiteOK = false;
    if (this.lastHipY !== null) {
      const v = hipY - this.lastHipY;
      if (this.lastHipV !== null && !h.airborne && h.jumpPhase === 'GROUNDED') {
        this.hipJerk = Math.max(this.hipJerk, Math.abs(v - this.lastHipV));
      }
      this.lastHipV = v;
    }
    this.lastHipY = hipY;

    // Tras aterrizar de un salto ambos pies están apoyados: cualquiera puede dar el primer paso.
    if (h.jumpPhase === 'LANDING' && this.lastJumpPhase !== 'LANDING') this.liftoffs += '|';
    this.lastJumpPhase = h.jumpPhase;

    if (h.gaitMode !== this.lastMode) {
      if (h.gaitMode === 'idle') this.idleTimes.push(time);
      this.lastMode = h.gaitMode;
    }
  }

  /** ¿Alterna pies en todos los pasos? */
  get alternates(): boolean {
    return !/LL|RR/.test(this.liftoffs);
  }
}

/**
 * Simula `seconds` segundos a `dt` fijo ejecutando el guion. Devuelve el Recorder.
 * `start`: tiempo inicial (para encadenar simulaciones sobre el mismo personaje).
 */
export function simulate(
  world: World,
  seconds: number,
  script: Step[] = [],
  options: { dt?: number | ((t: number) => number); recorder?: Recorder; start?: number; onFrame?: (t: number) => void } = {},
): Recorder {
  const { human } = world;
  const recorder = options.recorder ?? new Recorder(world);
  const pending = [...script].sort((a, b) => a[0] - b[0]);
  let t = options.start ?? 0;
  const end = t + seconds;
  while (t < end - 1e-9) {
    while (pending.length > 0 && pending[0][0] <= t + 1e-9) pending.shift()![1](human);
    const dt = typeof options.dt === 'function' ? options.dt(t) : options.dt ?? 1 / 60;
    human.update(dt);
    t += Math.min(dt, 0.25);
    recorder.sample(t);
    options.onFrame?.(t);
  }
  return recorder;
}

/** Diferencia entre dos ángulos (rad), en (−π, π]. */
export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Distancia horizontal entre dos puntos (m). */
export function horizontalDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
