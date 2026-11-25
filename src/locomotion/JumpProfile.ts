import type { LocomotionConfig } from './LocomotionConfig.ts';

/** What a jump is asked to do. Both optional: without them, `jumpSpeed` up, keeping the speed it has. */
export interface JumpIntent {
  /** Horizontal distance from take-off to landing (m). */
  distance?: number;
  /** How high the body rises at the top, above take-off (m). */
  height?: number;
}

/** What the profile of a jump is computed from. */
export interface JumpProfileInput {
  /** Horizontal speed when the jump is asked for (m/s). */
  speed: number;
  intent?: JumpIntent;
  /** Height of the landing relative to take-off (m; negative = lower, jumping down). */
  rise?: number;
  /** Taking off from standing, with both feet (by default, below ). */
  standing?: boolean;
  /**
   * From one foot to the other across a gap (see LocomotionController.leapFrom): its legs and arms in the air are its
   * own, and the flight keeps the reference curves (tuck at once, landing prepared at the end).
   */
  stride?: boolean;
}

/**
 * Profile of a jump: its physics (take-off velocity, flight) and, from them, every pose and timing parameter of the
 * jump. `jumpSpeed`, `jumpCrouch`, `jumpTuck`, `jumpLandingPrep`, `jumpToeOff` and `landingTime` are those of the
 * reference jump (straight up at `jumpSpeed`, landing at the same height, `effort` 1): the others scale from them.
 */
export interface JumpProfile {
  /** Horizontal speed when it was asked for (m/s). */
  approach: number;
  /** Take-off velocity: horizontal and vertical (m/s). */
  vx: number;
  vy: number;
  /** Time in the air (s), horizontal distance (m), rise of the body at the top (m) and of the landing (m). */
  flight: number;
  distance: number;
  height: number;
  rise: number;
  /** Falling speed on landing (m/s). */
  impact: number;
  /** False if the intent asked for more than the character can do (then it does what it can). */
  reachable: boolean;
  /**
   * Effort: the velocity the legs give it (vertical, and horizontal beyond the speed it had, which costs less:
   * JUMP_FORWARD_COST), × jumpSpeed. 1 = the reference jump; at most JUMP_MAX_EFFORT.
   */
  effort: number;
  /** From standing, with both feet (see the take-off below); if not, in stride (the reference curves, for now). */
  standing: boolean;
  /** From one foot to the other across a gap (see JumpProfileInput.stride). */
  stride: boolean;
  /**
   * Preparation: how far the hips sink (m) and how long it takes (s): from standing, going down (`descentTime`) and
   * pushing up (`pushTime`, accelerating evenly to `vy`). How far the arms go back (degrees).
   */
  crouch: number;
  takeoffTime: number;
  descentTime: number;
  pushTime: number;
  armBack: number;
  /** From standing: how far the arms go forward and up at take-off (degrees; overhead jumping up, ~90° jumping far). */
  armUp: number;
  /**
   * Lean of the trunk at the bottom of the preparation (rad) and, from standing, at take-off (jumping far, it stays
   * forward). Heel raise at take-off (degrees).
   */
  lean: number;
  leanTakeoff: number;
  toeOff: number;
  /** In the air: how far the arms go forward (degrees; from standing, where they come down to) and in how long (s). */
  armForward: number;
  armAirTime: number;
  /**
   * In the air: how much the feet tuck (m); they stay extended for `tuckDelay` s and are tucked at `tuckTime` s (near
   * the top); the legs extend towards the landing in the last `landingPrep` s.
   */
  tuck: number;
  tuckDelay: number;
  tuckTime: number;
  landingPrep: number;
  /** In the air: the trunk leans forward this much by the landing (rad) and the head looks down this much (rad). */
  airLean: number;
  gaze: number;
  /** Landing: how far the arms go forward (degrees) and how long the cushioning lasts (s). */
  armLanding: number;
  landingTime: number;
  /**
   * Landing: how far the hips have already gone down when touching the ground (m: the knees arrive bent), how much the
   * arms open to the sides (degrees) and on what part of the foot it lands (rad; + heel first, toes raised, jumping
   * far; − ball first, heel raised, jumping up; 0 in stride: the gait's).
   */
  preflex: number;
  armSpread: number;
  landingRoll: number;
}

/** Most effort of a jump (× that of the reference jump, `jumpSpeed` straight up). */
export const JUMP_MAX_EFFORT = 1.25;
/** Least vertical take-off speed (× jumpSpeed): below that it isn't a jump. */
const JUMP_MIN_UP = 0.2;
/**
 * Horizontal speed costs this share of the vertical one: the legs push forward more easily than up (a standing long
 * jump of ~2 m, at ~4.6 m/s forward and ~2.1 up, is an effort of ~1.1).
 */
const JUMP_FORWARD_COST = 0.6;
/** Take-off angle of a standing long jump (degrees above the horizontal; biomechanics: ~20–30°). */
const STANDING_ANGLE = 25;
/**
 * Below this share of walkSpeed (0.3 m/s at 1.4), a jump starts from standing (with both feet; with a distance, with
 * STANDING_ANGLE). Relative, like everything that depends on the size: with speedScale, speeds go with it.
 */
const STANDING_SHARE = 0.3 / 1.4;

/** Speed below which a jump starts from standing (m/s; see STANDING_SHARE). */
export function standingSpeed(config: LocomotionConfig): number {
  return STANDING_SHARE * config.walkSpeed;
}
/**
 * Moving, a jump without an intent goes up less the faster it goes (× jumpSpeed, at runSpeed): the push is short and
 * the speed it brings is kept, so a running jump is long and fairly low (biomechanics).
 */
const MOVING_UP_DROP = 0.5;
/** Reference jump: arms back in the preparation, forward in the air (in ARM_AIR_TIME s) and on landing (degrees). */
const ARM_BACK = 35;
const ARM_FORWARD = 40;
const ARM_AIR_TIME = 0.5;
const ARM_LANDING = 20;
/** Reference jump: lean of the trunk in the preparation (degrees) and time to tuck the feet after take-off (s). */
const LEAN = 12;
const TUCK_TIME = 0.15;
/** How the depth of the preparation grows with the effort (crouch = jumpCrouch · effort^CROUCH_EXPONENT). */
const CROUCH_EXPONENT = 1.5;
/**
 * From standing: the depth grows faster (knees at ~30° in a hop, ~90° in the hardest jump), but at least what pushing
 * up for STANDING_PUSH_MIN s needs to reach vy (d = vy · t / 2, accelerating evenly).
 */
const STANDING_CROUCH_EXPONENT = 2.5;
const STANDING_PUSH_MIN = 0.184;
/**
 * From standing: going down takes STANDING_DESCENT · √effort (with the push, ~0.25 s in the reference jump). These two
 * times, in units of jumpSpeed / gravity (0.33 s by default), which go with the size like every duration.
 */
const STANDING_DESCENT = 0.552;
/** From standing: arms back (ARM_BACK · effort^ARM_BACK_EXPONENT: 40–60° in the hardest jumps). */
const ARM_BACK_EXPONENT = 1.5;
/**
 * From standing, arms at take-off in the reference jump (degrees forward): jumping up, ARM_UP_VERTICAL (above the
 * head); jumping far, at STANDING_ANGLE, ARM_UP_LONG (~forward). × effort, at most ARM_UP_MAX.
 */
const ARM_UP_VERTICAL = 130;
const ARM_UP_LONG = 80;
const ARM_UP_MAX = 170;
/** From standing, jumping far: the trunk leans this much more at the bottom and keeps this much at take-off (degrees). */
const LONG_LEAN = 15;
const LONG_LEAN_TAKEOFF = 20;
/** The tuck grows with the flight up to this many times the reference one. */
const TUCK_MAX = 1.5;
/**
 * In the air (shares of the flight): the legs stay extended for TUCK_DELAY (the push isn't over at once), are tucked
 * at TUCK_PEAK (near the top) and from there go towards the landing (LANDING_PREP): no pause between them. Before, they
 * were tucked at 0.15 s whatever the flight and held there until 0.22 s before landing (up to 16 frames still).
 */
const TUCK_DELAY = 0.03;
const TUCK_PEAK = 0.5;
const LANDING_PREP = 0.55;
/**
 * In the air the trunk leans forward towards the landing (AIR_LEAN · effort, degrees; jumping far, AIR_LEAN_LONG more)
 * and the head looks down at it (GAZE, degrees). Before, both stood still for the whole flight.
 */
const AIR_LEAN = 6;
/**
 * Landing: the hips go down LANDING_PREFLEX × jumpCrouch before touching the ground (× the impact squared, against
 * jumpSpeed, between 0.5 and 2: knees at ~15–30° on contact; before, 5–6°, straight), the arms open ARM_SPREAD° (× the impact)
 * and, from standing, it lands on the ball of the foot (LANDING_BALL°) jumping up and on the heel (LANDING_HEEL°)
 * jumping far.
 */
const LANDING_PREFLEX = 0.1;
const ARM_SPREAD = 12;
const LANDING_BALL = 8;
const LANDING_HEEL = 20;
const AIR_LEAN_LONG = 8;
const GAZE = 12;
/** The cushioning lasts landingTime · √(impact / jumpSpeed), between these shares of landingTime. */
const LANDING_TIME_MIN = 0.5;
const LANDING_TIME_MAX = 1.5;

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/** How long the cushioning lasts landing at `impact` m/s (s): longer the harder it lands. */
export function landingTimeFor(config: LocomotionConfig, impact: number): number {
  return config.landingTime * clamp(Math.sqrt(impact / Math.max(config.jumpSpeed, 1e-6)), LANDING_TIME_MIN, LANDING_TIME_MAX);
}

/** Time in the air (s) taking off at `vy` m/s and landing `rise` m higher; NaN if it doesn't get there. */
function flightTime(vy: number, rise: number, g: number): number {
  const root = vy * vy - 2 * g * rise;
  return root < 0 ? Number.NaN : (vy + Math.sqrt(root)) / g;
}

/**
 * Profile of a jump (see JumpProfile): from the speed it has, what is asked of it and the height of the landing. The
 * physics is ballistic; the pose and timing parameters are named, monotonic curves of the effort and of the flight,
 * equal to the configuration's in the reference jump. Pure: it doesn't change anything.
 */
export function computeJumpProfile(config: LocomotionConfig, input: JumpProfileInput): JumpProfile {
  const g = Math.max(config.gravity, 1e-6);
  const top = Math.max(config.jumpSpeed, 1e-6);
  const speed = Math.max(input.speed, 0);
  const rise = input.rise ?? 0;
  const intent = input.intent ?? {};
  const lowest = Math.max(JUMP_MIN_UP * top, Math.sqrt(Math.max(2 * g * rise, 0)) + 1e-3);
  let reachable = true;
  let vx = speed;
  const unit = top / g;
  let vy = speed >= standingSpeed(config) ? top * (1 - MOVING_UP_DROP * Math.min(speed / Math.max(config.runSpeed, 1e-6), 1)) : top;
  const height = intent.height;
  const distance = intent.distance;
  if (height !== undefined && height > 0) vy = Math.sqrt(2 * g * height);
  if (distance !== undefined && distance > 0) {
    if (height !== undefined && height > 0) {
      vx = distance / (flightTime(Math.max(vy, lowest), rise, g) || 1);
    } else if (speed >= standingSpeed(config)) {
      // En movimiento conserva su velocidad: el vuelo que necesita a esa velocidad dice cuánto subir.
      const t = distance / speed;
      vy = rise / t + (g * t) / 2;
    } else {
      // Desde parado, con el ángulo de un salto de longitud: la velocidad, por bisección.
      const a = (STANDING_ANGLE * Math.PI) / 180;
      let lo = 0;
      let hi = 4 * top;
      for (let i = 0; i < 40; i++) {
        const v = (lo + hi) / 2;
        const t = flightTime(v * Math.sin(a), rise, g);
        if (!(v * Math.cos(a) * t >= distance)) lo = v;
        else hi = v;
      }
      vx = hi * Math.cos(a);
      vy = hi * Math.sin(a);
    }
  }
  if (vy < lowest) {
    if (height !== undefined || rise > 0) reachable = false;
    vy = lowest;
  }
  // Más que JUMP_MAX_EFFORT no puede: lo que piden las piernas se recorta en la misma dirección.
  const push = (dx: number, dy: number): number => Math.hypot(JUMP_FORWARD_COST * dx, dy) / top;
  let effort = push(vx - speed, vy);
  if (effort > JUMP_MAX_EFFORT) {
    reachable = false;
    const k = JUMP_MAX_EFFORT / effort;
    vx = speed + (vx - speed) * k;
    vy = Math.max(vy * k, lowest);
    effort = push(vx - speed, vy);
  }
  let flight = flightTime(vy, rise, g);
  if (Number.isNaN(flight)) {
    reachable = false;
    flight = vy / g;
  }
  if (distance !== undefined && vx * flight < distance - 1e-6) reachable = false;
  const impact = Math.sqrt(Math.max(vy * vy - 2 * g * rise, 0));
  // Curvas: iguales a la configuración en el salto de referencia (esfuerzo 1, vuelo 2·jumpSpeed/g, impacto jumpSpeed).
  const share = flight / ((2 * top) / g);
  const stride = input.stride ?? false;
  const standing = !stride && (input.standing ?? speed < standingSpeed(config));
  let crouch = config.jumpCrouch * effort ** CROUCH_EXPONENT;
  // La de la curva de las caderas −k·u²(1−u), de profundidad k·4/27 y que termina a vy (k = vy · duración).
  let takeoffTime = (27 * crouch) / (4 * vy);
  let descentTime = (takeoffTime * 2) / 3;
  let pushTime = takeoffTime / 3;
  let armBack = ARM_BACK * effort;
  let armUp = 0;
  let lean = LEAN * effort * (Math.PI / 180);
  let leanTakeoff = 0;
  let up = 1;
  if (standing) {
    // Cuánto va hacia arriba lo que empujan las piernas: 0 de un salto de longitud (STANDING_ANGLE), 1 de uno vertical.
    const angle = Math.atan2(vy, JUMP_FORWARD_COST * Math.max(vx - speed, 0)) / (Math.PI / 180);
    up = clamp((angle - STANDING_ANGLE) / (90 - STANDING_ANGLE), 0, 1);
    crouch = Math.max(config.jumpCrouch * effort ** STANDING_CROUCH_EXPONENT, (vy * STANDING_PUSH_MIN * unit) / 2);
    pushTime = (2 * crouch) / vy;
    descentTime = STANDING_DESCENT * unit * Math.sqrt(effort);
    takeoffTime = descentTime + pushTime;
    armBack = ARM_BACK * effort ** ARM_BACK_EXPONENT;
    armUp = Math.min((ARM_UP_LONG + (ARM_UP_VERTICAL - ARM_UP_LONG) * up) * effort, ARM_UP_MAX);
    lean = (LEAN + LONG_LEAN * (1 - up)) * effort * (Math.PI / 180);
    leanTakeoff = LONG_LEAN_TAKEOFF * (1 - up) * effort * (Math.PI / 180);
  }
  return {
    approach: speed,
    vx,
    vy,
    flight,
    distance: vx * flight,
    height: (vy * vy) / (2 * g),
    rise,
    impact,
    reachable,
    effort,
    standing,
    stride,
    crouch,
    takeoffTime,
    descentTime,
    pushTime,
    armBack,
    armUp,
    lean,
    leanTakeoff,
    toeOff: config.jumpToeOff * Math.min(effort, 1),
    armForward: ARM_FORWARD * effort,
    armAirTime: stride ? ARM_AIR_TIME * share : flight,
    tuck: config.jumpTuck * Math.min(share, TUCK_MAX),
    tuckDelay: stride ? 0 : TUCK_DELAY * flight,
    tuckTime: stride ? TUCK_TIME * share : TUCK_PEAK * flight,
    landingPrep: stride ? config.jumpLandingPrep * share : LANDING_PREP * flight,
    airLean: stride ? 0 : (AIR_LEAN + AIR_LEAN_LONG * (1 - up)) * effort * (Math.PI / 180),
    gaze: stride ? 0 : GAZE * (Math.PI / 180),
    armLanding: ARM_LANDING * (impact / top),
    landingTime: landingTimeFor(config, impact),
    preflex: stride ? 0 : config.jumpCrouch * LANDING_PREFLEX * clamp((impact / top) ** 2, 0.5, 2),
    armSpread: stride ? 0 : ARM_SPREAD * Math.min(impact / top, 1.5),
    landingRoll: standing ? (LANDING_HEEL * (1 - up) - LANDING_BALL * up) * (Math.PI / 180) : 0,
  };
}
