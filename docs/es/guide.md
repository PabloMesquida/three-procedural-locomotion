# Guía de uso

[English](../en/guide.md)

`three-procedural-locomotion` mueve un modelo humanoide de Three.js sin animaciones: a partir de una velocidad y un rumbo
deseados calcula el ritmo de los pasos (gait), dónde apoyar cada pie (footstep planning), la pierna con IK y
la postura del cuerpo (pelvis, torso, cabeza, brazos). Camina, corre, gira, se agacha, salta y va hasta un
punto, sobre cualquier suelo que pueda consultar con un rayo.

Ejemplo completo y comprobado: [`examples/basic.ts`](../../examples/basic.ts).

## Crear el personaje

```ts
import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

const gltf = await new GLTFLoader().loadAsync('/humanoid.glb');
scene.add(gltf.scene);

const human = createProceduralHuman({
  model: gltf.scene,          // la librería lo mueve y lo orienta
  mapping: mixamoMapping,     // nombres de los bones (otros rigs: docs/es/skeletons.md)
  ground: [floorMesh],        // mallas del suelo, o un GroundDetector propio
  preset: 'tired',            // opcional: estilo de marcha
  config: { walkSpeed: 0.9 }, // opcional: solo lo que quieras cambiar
});

// cada frame, después de dar las órdenes y antes de renderizar
human.update(dt);
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `model` | — | Raíz del personaje (`gltf.scene`). Puede colgar de cualquier objeto movido, girado o escalado uniformemente. |
| `mapping` | — | Qué bone es cada parte del cuerpo (`mixamoMapping`, `rigifyMapping` o uno propio). Si falta uno obligatorio lanza `RigMappingError`; los avisos (del mapping y del modelo: escala, pose de reposo, origen, proporciones; ver [esqueletos](skeletons.md#3-comprobar)) quedan en `human.warnings`. |
| `ground` | — | `Object3D[]` (raycast contra esas mallas y sus hijos) o un `GroundDetector` (p. ej. `StaticGroundDetector`, ver [Suelo](#suelo)). |
| `forward` | estimado | Dirección (world, horizontal) hacia la que mira el modelo en reposo. Se estima con los dedos de los pies. |
| `preset` | — | `'tired'`, `'sneaky'`, `'athletic'` o `'heavy'`. |
| `config` | — | Parámetros a cambiar ([referencia](parameters.md)). Mandan sobre el `preset`. |
| `bodyScale` | `'auto'` | Factor de las longitudes de la configuración (ver *Tamaño*). |
| `speedScale` | `'auto'` | Velocidades y ritmos según el tamaño, como entre un niño y un adulto; `'off'`: los de la configuración (ver *Tamaño*). |
| `maxTimeStep` | 1/30 s | Paso máximo de simulación (ver *Frames irregulares*). |
| `maxFrameTime` | 0,25 s | Tiempo máximo simulado por llamada a `update`. |
| `seed` | 1 | Semilla de la variación natural: personajes con semillas distintas no se mueven igual; la misma semilla repite el mismo movimiento. |

Requisitos de la escena: metros (1 unidad = 1 m) y eje Y hacia arriba.

**Renderer: WebGPU o WebGL.** La librería solo mueve huesos (en la CPU, unos microsegundos por personaje) y
consulta el suelo con raycasts: no depende del renderer. `examples/basic.ts` usa
`WebGPURenderer` (`three/webgpu`), que cae a WebGL 2 si el navegador no tiene WebGPU; con `WebGLRenderer`
funciona igual. Se puede importar Three desde `three/webgpu` en tu aplicación aunque la librería importe de
`three`: los dos comparten las mismas clases (`three.core.js`). El skinning de la malla lo hace el renderer en la GPU.

## Control

Dos formas, que se pueden mezclar:

- **Continua** (teclado, mando, IA propia): `targetSpeed` (m/s) y `targetHeading` (rad). El cuerpo acelera,
  frena y gira hacia ellos con sus límites (aceleración, velocidad de giro, aceleración lateral).
- **Por destino**: `moveTo(punto, { run })` va hasta un punto del suelo; si queda de lado gira caminando, en
  una curva más cerrada cuanto más cerca está; si queda detrás (más de 120°) frena y gira hacia él en 2–3
  pasos grandes que ya se desplazan hacia la nueva dirección (~1 s para 180°, como una persona) y sale en
  línea recta. Ajusta la velocidad para no
  rodearlo y frena para detenerse en él (±5–10 cm). Emite `arrive`.
  Dar `targetSpeed` o `targetHeading` a mano lo cancela; `stop()` también.

Además: `targetCrouch` (0 = de pie, 1 = agachado), `jump()` (devuelve `false` si ya está saltando).

**Rumbo**: `0` = la orientación del modelo al crearlo; positivo = a la izquierda (visto desde arriba, sentido
antihorario). Para girar hacia una dirección del mundo `dir` (horizontal, normalizada):

```ts
const current = human.locomotion.body.state.forward; // dirección actual (world)
const turn = Math.atan2(new Vector3().crossVectors(current, dir).y, current.dot(dir));
human.targetHeading = human.heading + turn;
```

**Cambios de dirección**: no gira en el sitio ni de golpe. Cuanto mayor es el giro que le queda por hacer, más
frena (`turnSlowdown`: con 180° pendientes va a ~0,55 × la velocidad; con 15°, igual) y la curva se cierra; al
completar el giro recupera la velocidad. La cabeza y el pecho miran antes hacia el nuevo rumbo, y cada pie
aterriza ya orientado hacia donde irá el cuerpo, sin acelerar el ritmo de los pasos; si aun así la pierna se
torcería más de 20° (el pie que ya estaba apoyado al empezar el giro), ese pie pivota sobre la punta. La rapidez del giro la
marcan `turnSpeed` y `maxLateralAcceleration`.

Correr no es un modo aparte: `walkSpeed` (1,4 m/s) es la velocidad normal de caminar, pero se sigue caminando, a
paso vivo, hasta `runStartSpeed` (1,7 m/s); por encima la marcha pasa gradualmente a carrera (`runBlend`) en
`runTransition` (completa hacia 2,3 m/s; una persona cambia hacia los 2 m/s) y se puede acelerar hasta `runSpeed`.
Agachado la velocidad se limita a `crouchMaxSpeed`.

## Estado

| Lectura | Qué es |
|---|---|
| `position` | Posición de la raíz (world). Es de solo lectura: para moverlo, ver *Teletransportar*. |
| `speed`, `velocity` | Velocidad horizontal (m/s) y vector velocidad (world). |
| `heading` | Rumbo actual (rad, misma convención que `targetHeading`). |
| `gaitMode` | `'idle'` (quieto, pies apoyados) o `'walk'` (dando pasos, caminando o corriendo). |
| `runBlend` | 0 = caminar, 1 = correr. |
| `crouch` | Agachado actual (0–1). |
| `airborne`, `jumpPhase` | En el aire; fase del salto: `GROUNDED`, `TAKEOFF`, `AIRBORNE`, `LANDING`. |
| `moveTarget` | Destino del `moveTo` en curso, o `null`. |
| `footPhase(lado)` | `PLANT` (aterriza de talón), `PLANTED`, `LIFT` (levanta el talón) o `SWING`. |
| `legLength`, `bodyScale`, `speedScale` | Largo de pierna del modelo (m), factor de las longitudes y de las velocidades. |
| `config`, `effectiveConfig` | Configuración sin escalar / la que se usa (longitudes × `bodyScale`). |

## Eventos

```ts
const off = human.on('footstep', ({ side, position, speed }) => playStep(side, position, speed));
human.on('liftoff', ({ speed }) => {});        // despega en un salto
human.on('land', ({ impactSpeed }) => {});     // aterriza (velocidad de caída, m/s)
human.on('arrive', ({ position }) => {});      // llegó al destino de moveTo (no si se cancela)
human.on('touch', ({ side, point }) => {});     // apoyó una mano en una superficie
off();                                         // o human.off('footstep', listener)
```

`footstep` se emite cuando un pie toca el suelo, también al aterrizar de un salto (uno por pie).
Las posiciones que llegan en los eventos son copias: se pueden guardar.

## Configuración

Todos los parámetros son opcionales y están, con nombre, unidad y valor por defecto, en la
**[referencia de parámetros](parameters.md)**. Se validan: un nombre mal escrito, un valor no numérico o fuera
de rango lanza `ConfigError` con la lista de problemas (`error.problems`, en inglés) y no se aplica nada.

```ts
human.setConfig({ stepHeight: 0.07, armSwing: 22 }); // en ejecución, se aplica en el siguiente frame
```

Todos se pueden cambiar en ejecución salvo los marcados ⚑ en la referencia (hoy solo `kneePoleDistance`),
que avisan por consola. `setConfig` acumula cambios sobre la configuración actual.

## Estilos (presets)

`tired` (cansado), `sneaky` (sigiloso), `athletic` (atlético) y `heavy` (pesado). Son solo conjuntos de
parámetros (`stylePresets`); la referencia muestra qué cambia cada uno.

```ts
createProceduralHuman({ ..., preset: 'sneaky', config: { walkSpeed: 0.8 } }); // config manda sobre el estilo
human.applyPreset('heavy');                       // en ejecución
human.applyPreset('heavy', { runSpeed: 2.8 });    // con cambios propios encima
human.applyPreset('default');                     // sin estilo
```

`applyPreset` reinicia **toda** la configuración (por defecto + estilo + `overrides`): lo cambiado antes con
`setConfig` se pierde salvo que lo pases en `overrides`. Para un estilo propio, crea un objeto con los
parámetros y pásalo como `config` o con `setConfig`.

## Controles básicos

Para cambiar cómo camina sin entrar en los 116 parámetros: once controles de alto nivel (`basicControls`), cada
uno mueve a la vez varios parámetros. Son una capa sobre la configuración, como los estilos:
`applyBasicControls(base, valores)` devuelve los parámetros resultantes para `setConfig`.

```ts
import { applyBasicControls, defaultConfig, stylePresets } from 'three-procedural-locomotion';

human.setConfig(applyBasicControls(defaultConfig, { tempo: 1.2, armSwing: 0.6, intensity: 1.3 }));
// sobre un estilo:
const base = { ...defaultConfig, ...stylePresets.tired };
human.setConfig({ ...base, ...applyBasicControls(base, { lean: 5 }) });
```

| Control | Rango (neutro) | Qué hace |
|---|---|---|
| `tempo` (Ritmo) | 0,6–1,6 (1) | más rápido o más lento, con pasos del mismo tamaño |
| `stride` (Zancada) | 0,7–1,2 (1) | pasos más largos y más lentos a la misma velocidad |
| `stepHeight` (Altura del paso) | 0,3–2 (1) | cuánto levanta los pies y articula el pie |
| `knees` (Flexión de rodillas) | 0–2 (1) | marcha más elástica o más rígida |
| `hipSway` (Balanceo de cadera) | 0–2,5 (1) | movimiento de la pelvis y del peso |
| `armSwing` (Braceo) | 0–2,5 (1) | amplitud del balanceo de los brazos |
| `armSpread` (Separación de brazos) | −5–20° (0) | cuánto se separan los brazos del cuerpo, parado, caminando y corriendo |
| `armForward` (Posición de brazos) | −15–15° (0) | brazos más adelante o más atrás, parado y como centro del balanceo |
| `lean` (Inclinación) | −10–25° (0) | postura hacia delante o erguida |
| `looseness` (Soltura) | 0,5–2 (1) | cuerpo suelto, con inercia, o rígido |
| `agility` (Reactividad) | 0,4–2,5 (1) | arranca, frena y gira más rápido o más despacio |
| `naturalness` (Naturalidad) | 0–3 (1) | variación entre pasos |
| `intensity` (Intensidad) | 0–1,75 (1) | escala a la vez altura del paso, rodillas, balanceo y braceo |

Qué parámetros mueve cada uno: `basicControls[i].params`; para una interfaz, `label` y `description` traen el
nombre y una frase en inglés y en español (`label.es` = "Ritmo"…). Los valores fuera de rango se recortan, y todo el
rango de cada control está probado (marcha limpia con los tres modelos de los tests). Los parámetros técnicos
(fracciones del ciclo, sondas, salto, cabeza, point and click…) solo se ajustan uno a uno.

Para combinar con ajustes a mano, aplícalos después: `{ ...base, ...applyBasicControls(base, valores),
...ajustesAMano }`; así un parámetro ajustado a mano no lo mueve un control básico.

## Manos

Si el mapping incluye los dedos (`mixamoMapping` y `rigifyMapping` los incluyen), la mano se relaja en vez de
quedarse como en la pose de reposo del modelo (que suele tener los dedos rectos y separados): cada falange algo
doblada hacia la palma, los dedos juntos y el pulgar hacia el índice, y siguen al balanceo de la mano con un pequeño
retraso. `fingerCurl` (1 por defecto) dice cuánto: 0 = como en el modelo, más de 1 = mano más cerrada.

## Tocar superficies

Al pasar junto a una columna, una pared o la baranda de un puente, el personaje puede acercar la mano y
tocarla, sin dejar de caminar. Se le dice qué se puede tocar, igual que el suelo:

```ts
const human = createProceduralHuman({ model, mapping, ground: [floor], touchables: [columns, wall, railing] });
human.touchables = [otherZone];   // se puede cambiar en cualquier momento (null = nada)
human.autoTouch = false;          // no tocar solo (por defecto, sí)
human.touchSlide = false;         // tocar y soltar, sin deslizar la mano (por defecto, desliza)
```

Con `touchables` busca solo, con rayos cortos desde donde estará el hombro al terminar el gesto: paredes y
columnas al lado o algo por delante (rayos horizontales a la altura del pecho) y barandas a la altura de la
cadera (rayos hacia abajo), y no las caras que tiene de frente. Toca cada objeto una vez mientras siga cerca
(una pared larga no la toca a cada paso), con cada mano por su lado (puede ir con una en la pared y tocar
columnas con la otra), caminando o parado; corriendo o en el aire, no. Lo que queda lejos de la mano no lo
intenta: no estira el brazo de más.

El gesto, medido en los alcances de CMU (ver [naturalidad](naturalness.md#tocar-al-pasar)): la mano va de su
balanceo a la superficie en ~0,75 s con la velocidad en campana, por un recorrido algo curvo (el codo se dobla a
mitad y se estira al final); se apoya con la palma hacia la superficie y los dedos abiertos (hacia donde menos
gira la muñeca: arriba en una pared al lado, hacia fuera en una baranda). Caminando junto a una pared o una
baranda, la desliza por ella mientras siga al lado: arranca quieta, se pone a la velocidad del cuerpo y va junto
al hombro, pegada a la superficie (en una pared, bajando poco a poco a la altura de la cintura); cuando la
superficie se acaba (el final de la pared, una esquina) la suelta. Una columna es demasiado curva para deslizar:
la toca y, cuando queda atrás, la suelta, igual que con `touchSlide = false`. Parado, suelta tras un momento.
La mano vuelve a colgar en ~0,7 s, partiendo de donde estaba y con la velocidad que llevaba. El brazo del otro
lado sigue balanceándose.

A mano:

```ts
human.touch(point);                         // la apoya (y desliza, caminando) y la retira como al pasar; false si no llega
human.touch(point, { slide: false });       // sin deslizar
human.touch(point, { hold: true });         // la deja apoyada…
human.releaseTouch();                       // …hasta soltarla (o hasta que no llegue)
human.touch(point, { side: 'left', normal }); // mano y normal de la superficie (si no, la busca con touchables)
human.touchPhase('right');                  // 'none' | 'reach' | 'contact' | 'release'
```

Los tiempos y el alcance están en la sección *Tocar superficies* de la [referencia](parameters.md#tocar-superficies).
Si el rig no tiene dedos, la palma se toma como la cara de abajo de la mano en la pose de reposo (en T).
Un detector propio (física, BVH…) implementa `SurfaceDetector` (`cast(origen, dirección, distancia, out)`).

## Variación natural

Una persona nunca da dos pasos iguales. Con `variation` (1 por defecto; 0 = todos los pasos idénticos)
la cadencia, la inclinación del tronco, la mirada y el balanceo de cada brazo cambian un poco y despacio,
con un ruido suave que depende de la semilla (`seed`) del personaje. Es determinista: la misma semilla
repite exactamente el mismo movimiento (útil para tests o repeticiones). Para una multitud, da a cada
personaje su propia semilla.

## Tamaño del personaje

Las longitudes de la configuración (marcadas ↔ en la referencia: largo, ancho y altura de paso, cuánto
bajan las caderas, márgenes…) están pensadas para un humano de 1,83 m. Con `bodyScale: 'auto'` (por defecto)
se multiplican por *largo de pierna del modelo / 0,879 m*: un personaje de 1,1 m o de 2,7 m conserva sus
proporciones sin tocar nada. Y con `speedScale: 'auto'` (por defecto) también sus velocidades y su ritmo se
adaptan al tamaño (ver abajo).

- `bodyScale: 1`: las longitudes se usan tal cual, en metros.
- Los valores que pasas en `config` / `setConfig` son siempre los del personaje de referencia;
  `human.effectiveConfig` muestra los escalados.
- Escalar el modelo (`gltf.scene.scale.setScalar(0.6)`) o un padre funciona: el largo de pierna se mide en
  world space.

**Velocidades según el tamaño** (`speedScale: 'auto'`, por defecto). Con solo las longitudes escaladas, un
personaje pequeño que corre a 3 m/s da pasitos frenéticos y uno grande que camina a 1 m/s parece ir a cámara
lenta. Con `speedScale: 'auto'` se mueven como lo harían de verdad (semejanza dinámica, la que relaciona la
marcha de un niño con la de un adulto): con *s* = `bodyScale`,

- velocidades × √s (`walkSpeed`, `runStartSpeed`, `runSpeed`, `crouchMaxSpeed`, la de salto…): un niño de 1,1 m
  (s ≈ 0,6) camina a ~1,1 m/s, empieza a correr a ~1,3 m/s y corre como mucho a ~2,3 m/s;
- ritmos ÷ √s (pasos por segundo, velocidad de giro, frecuencias de los muelles) y duraciones × √s;
- aceleraciones y gravedad, iguales; los saltos son de altura proporcional a su tamaño.

```ts
human.targetSpeed = human.config.walkSpeed * human.speedScale; // su velocidad de marcha
createProceduralHuman({ model, mapping, ground, speedScale: 'off' }); // velocidades sin adaptar
```

Con el tamaño de referencia (`bodyScale` 1) no cambia nada. Con `'off'`, velocidades, aceleraciones, gravedad,
tiempos y ángulos no se escalan: un niño y un gigante a 1 m/s van a 1 m/s, cada uno con pasos de su tamaño.

`targetSpeed`, `speed`, `velocity` y las velocidades de los eventos son siempre m/s reales; `config` sigue con los
valores del personaje de referencia. Es exacto: el mismo movimiento a otra escala, con el tiempo × √s (lo prueban
los tests). Por dentro, la simulación usa una copia geométrica de la configuración (velocidades y aceleraciones
× s, que es lo que muestra `effectiveConfig`) y un reloj que corre a 1/√s.

## Suelo

Con `ground: [mallas]` se hace raycast vertical contra esas mallas (y sus hijos). Conviene pasar solo el suelo
(no paredes ni el propio personaje). Sirve para suelo que se mueve, pero el raycast de Three recorre todos los
triángulos: con mallas de miles de triángulos cada personaje cuesta milisegundos.

**Suelo estático grande** (terrenos, escaleras, ciudades): usa `StaticGroundDetector`. Precalcula un índice de
los triángulos (una vez: ~0,1 s por 50.000, ~0,6 s por 500.000) y cada consulta cuesta microsegundos, sea cual sea
el tamaño. Devuelve el mismo suelo que el raycast. Crea uno y compártelo entre todos los personajes:

```ts
import { StaticGroundDetector } from 'three-procedural-locomotion';

const ground = new StaticGroundDetector([terrainMesh, stairs]);
const a = createProceduralHuman({ model: modelA, mapping, ground });
const b = createProceduralHuman({ model: modelB, mapping, ground });

// Si el suelo cambia (se mueve, se edita, otra lista): ground.targets = [...]; ground.rebuild();
```

Solo lee mallas normales (`Mesh`); `InstancedMesh`, `SkinnedMesh` y `BatchedMesh` se ignoran con un aviso. Para
suelo que se mueve cada frame (plataformas, ascensores), usa el raycast (`ground: [mallas]`), o combina los dos
con un `GroundDetector` propio que consulte ambos y se quede con el más alto.

Para otro sistema (heightmap, motor de física) implementa `GroundDetector`:

```ts
const heightmapGround: GroundDetector = {
  castDown(origin, maxDistance, out) {
    const y = heightAt(origin.x, origin.z);
    if (origin.y - y > maxDistance || y > origin.y) return false;
    out.point.set(origin.x, y, origin.z);
    out.normal.copy(normalAt(origin.x, origin.z)); // unitaria, hacia arriba
    out.distance = origin.y - y;
    return true;
  },
};
```

El cuerpo es cinemático: no hay colisiones con obstáculos ni paredes; solo se busca el suelo bajo el cuerpo
y bajo cada pie. Escalones bajos y pendientes moderadas sí: los pies se apoyan en su altura y se inclinan.

### Escaleras

Las escaleras y los escalones se detectan en la geometría, sin marcar nada: cuando un paso aterrizaría en un
cambio de nivel, el personaje mide el suelo por delante en su dirección de avance, encuentra los bordes y:

- apoya cada pie en una huella, entero (el talón sobresale solo si la huella es más corta que el pie), sin
  saltarse ninguna: un paso por escalón, subiendo o bajando;
- frena para que cada paso avance un escalón, y vuelve a acelerar poco a poco cuando la escalera termina;
- el cuerpo sigue una línea suave sobre las huellas en vez del suelo justo debajo y se inclina algo hacia
  delante (más al subir que al bajar), y el pie en el aire libra los bordes con toda la planta (talón y punta
  de los dedos): al subir, sube primero; al bajar, primero avanza por encima del borde y luego baja; en un
  escalón el pie apoya plano, no de talón;
- una contrahuella más alta que `maxStepUp` es una pared: se para delante; de un desnivel más hondo que
  `maxStepDown` no baja: se para en el borde (los dos, 0,35 m por defecto, escalados con el tamaño).

Sirve cualquier medida de escalón hasta esos límites (probado de 10 × 40 cm a 30 × 30 cm, subiendo y bajando).
La forma del paso, la inclinación y el apoyo se comparan con capturas de movimiento de personas en escaleras
(CMU).

Consultas al suelo por personaje: una por frame (bajo el cuerpo) y unas 15 al empezar cada paso (dónde aterriza
y por dónde pasa la punta del pie). En una escalera, unas 50–90 por paso (el perfil del suelo por delante).
Parado, si el suelo bajo los pies cambia sin que se mueva el cuerpo (un objeto que aparece, un cambio de
`setConfig`), se recoloca en como mucho 0,25 s.

## Frames irregulares

`update(dt)` divide los frames largos en pasos de como mucho `maxTimeStep` y nunca simula más de
`maxFrameTime` por llamada: el movimiento no depende de los fps y un parón (cambiar de pestaña) no provoca un
salto. Pasa el `dt` real (`clock.getDelta()`); `dt ≤ 0` no hace nada.

## Caminar en el sitio y origen flotante

`human.shiftOrigin(offset)` desplaza al personaje sin cambiar su movimiento: sigue caminando, corriendo o en el
aire exactamente igual, con los pies, las trayectorias y el destino de `moveTo` desplazados con él (a
diferencia de moverlo y llamar a `reset()`, que lo detiene).

```ts
// En el sitio (cinta de correr): cada frame, lo que avanzó en horizontal, de vuelta.
human.update(dt);
const p = human.position;
human.shiftOrigin(new Vector3(anchor.x - p.x, 0, anchor.z - p.z));

// Origen flotante (mundos grandes): desplazar a la vez el suelo y el personaje.
world.position.add(offset);
human.shiftOrigin(offset);
```

El suelo no se mueve con él: en el sitio nuevo tiene que ser el mismo (llano para caminar en el sitio, o el
mismo suelo desplazado). Con `StaticGroundDetector`, si mueves el suelo, llama a `rebuild()`.

## Teletransportar, pausar, eliminar

- **Teletransportar**: mueve `gltf.scene` (o su padre) y llama a `human.reset()`: lo deja quieto, con los pies
  apoyados en el suelo que haya debajo (hasta 50 m) y cancela `moveTo`.
- **Dejar de controlarlo** (p. ej. para otra animación): `human.restPose()` devuelve el esqueleto a su pose de
  reposo; `reset()` vuelve a tomar el control.
- **Eliminar**: `human.dispose()` (pose de reposo y sin suscripciones). El modelo sigue siendo tuyo.
- Mientras esté activo, no muevas ni gires el modelo ni sus huesos de piernas, caderas, torso o brazos.

## Varios personajes

Cada `createProceduralHuman` es independiente (configuración, estado y eventos propios). Se pueden mezclar
tamaños, estilos y rigs en la misma escena; cada uno necesita su propio modelo (`SkeletonUtils.clone` para
copiar uno cargado). El detector de suelo sí se comparte: un mismo `StaticGroundDetector` (o `GroundDetector`)
para todos. Coste orientativo de `update` por personaje: ~0,1–0,2 ms (con `StaticGroundDetector`, también sobre
mallas grandes); `npm run bench` lo mide en tu máquina.

## Avanzado

- `human.locomotion` y `human.navigation`: controladores internos (gait, pies, pelvis, cuerpo, point and
  click). Útiles para depurar; su forma puede cambiar entre versiones.
- Se exportan también los bloques (`TwoBoneIK`, `LegIK`, `FootPlacement`, `mapHumanRig`, `inspectSkeleton`…).
- `three-procedural-locomotion/debug`: ayudas visuales (`LocomotionDebug`, `GaitDiagram`, `RigDebug`, `IKDebug`,
  `FootDebug`). `GaitDiagram` muestra sus textos en inglés; en español:
  `new GaitDiagram(human.locomotion.gait, { language: 'es' })`.

## Limitaciones actuales

- Sin colisiones ni física (el cuerpo no choca con obstáculos); `moveTo` va en línea recta, sin pathfinding.
- Escaleras: subir y bajar caminando por tramos rectos. Todavía no hay escaleras corriendo, en curva ni de
  caracol, ni escaleras sin contrahuella (huellas sueltas). La rodilla de apoyo se dobla más que en las capturas
  (≈ 80° al subir y ≈ 95° al bajar, frente a 55° y 68°). Tampoco saltos planificados a otra altura.
- Rigs probados: Mixamo y el metarig de Rigify. Otros rigs deben funcionar con su mapping, pero no están
  verificados (ver [esqueletos](skeletons.md)).
