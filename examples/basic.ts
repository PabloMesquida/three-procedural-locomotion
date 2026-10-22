/**
 * Minimal integration of three-procedural-locomotion into a Three.js scene.
 *
 *  - Loads a humanoid model (GLB with a Mixamo rig) and puts it on a floor.
 *  - Click: walk to the point. Shift + click: run.
 *  - WASD / arrows: move relative to the camera (cancels the click). Space: jump. C: crouch.
 *
 * Rendered with WebGPU (`three/webgpu`).
 *
 * In your project, `three-procedural-locomotion` is the installed package. Here, `tsconfig.json`
 * points that name to `src/` to type-check the example without building the library.
 */
import {
  AmbientLight,
  Clock,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

// ---------- Scene (in meters, Y up) ----------
// WebGPU (with automatic WebGL 2 fallback if the browser doesn't have it). The library doesn't depend on
// the renderer: it works the same with WebGLRenderer.
const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(3, 6, 4);
scene.add(sun);

const floor = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: 0x777777 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// ---------- Character ----------
const gltf = await new GLTFLoader().loadAsync('/humanoid.glb');
scene.add(gltf.scene);

const human = createProceduralHuman({
  model: gltf.scene, // the library moves and orients it: don't move it yourself
  mapping: mixamoMapping, // bone names (see docs/en/skeletons.md for other rigs)
  ground: [floor], // meshes that count as ground
  preset: 'athletic', // optional: walking style
  config: { walkSpeed: 1.2 }, // optional: only what you want to change
});
for (const warning of human.warnings) console.warn(warning);

human.on('footstep', ({ side, speed }) => console.log(`${side} step at ${speed.toFixed(1)} m/s`));
human.on('arrive', () => console.log('arrived'));

// ---------- Click: go to the point ----------
const raycaster = new Raycaster();
const pointer = new Vector2();
renderer.domElement.addEventListener('pointerdown', (event) => {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(floor)[0];
  if (hit) human.moveTo(hit.point, { run: event.shiftKey });
});

// ---------- Keyboard: move relative to the camera ----------
const keys = new Set<string>();
addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (event.code === 'Space') human.jump();
  if (event.code === 'KeyC') human.targetCrouch = human.targetCrouch > 0 ? 0 : 1;
});
addEventListener('keyup', (event) => keys.delete(event.code));

const input = new Vector3();
const cameraForward = new Vector3();
const cameraRight = new Vector3();
const axis = new Vector3();
let wasSteering = false;

/** Direction requested with the keyboard (world, horizontal) and whether running is requested. */
function steering(): { direction: Vector3; run: boolean } | null {
  const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
  const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  if (forward === 0 && right === 0) return null;
  camera.getWorldDirection(cameraForward).setY(0).normalize();
  cameraRight.crossVectors(cameraForward, camera.up).normalize();
  input.copy(cameraForward).multiplyScalar(forward).addScaledVector(cameraRight, right).normalize();
  return { direction: input, run: keys.has('ShiftLeft') || keys.has('ShiftRight') };
}

function updateKeyboard(): void {
  const wanted = steering();
  if (!wanted) {
    if (wasSteering) human.stop(); // when the keys are released (without cancelling a later click)
    wasSteering = false;
    return;
  }
  wasSteering = true;
  // The heading is measured from the initial orientation (positive = to the left):
  // add the angle between the current direction and the requested one.
  const current = human.locomotion.body.state.forward;
  const turn = Math.atan2(axis.crossVectors(current, wanted.direction).y, current.dot(wanted.direction));
  human.targetHeading = human.heading + turn;
  human.targetSpeed = wanted.run ? human.config.runSpeed : human.config.walkSpeed;
}

// ---------- Loop ----------
const clock = new Clock();
renderer.setAnimationLoop(() => {
  updateKeyboard(); // commands first…
  human.update(clock.getDelta()); // …then the simulation…
  camera.position.copy(human.position).add(new Vector3(0, 2.2, 4.5)); // …the camera follows the character…
  camera.lookAt(human.position.x, human.position.y + 1, human.position.z);
  renderer.render(scene, camera); // …and it is drawn
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
