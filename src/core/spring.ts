/**
 * Single-value damped spring (angle, distance…): chases its target with inertia. Used to give weight and
 * lag to parts of the body (trunk, arms).
 */
export interface Spring {
  target: number;
  value: number;
  velocity: number;
}

export function createSpring(): Spring {
  return { target: 0, value: 0, velocity: 0 };
}

/** Puts the spring at its target, at rest (at the start or after a teleport). */
export function snapSpring(spring: Spring): void {
  spring.value = spring.target;
  spring.velocity = 0;
}

/**
 * Advances the spring by `dt` seconds (angular frequency `w` rad/s, damping `zeta`; 1 = no overshoot).
 * Semi-implicit integration in steps of at most 1/120 s and with w·h ≤ 0.5: stable at any frequency and
 * independent of the frame rate.
 */
export function stepSpring(spring: Spring, w: number, zeta: number, dt: number): void {
  if (!(dt > 0)) return;
  const steps = Math.max(Math.ceil(dt * 120 - 1e-9), Math.ceil((dt * w) / 0.5));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += (w * w * (spring.target - spring.value) - 2 * zeta * w * spring.velocity) * h;
    spring.value += spring.velocity * h;
  }
}
