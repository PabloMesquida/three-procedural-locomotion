# Naturalidad: comparación con capturas de movimiento

[English](../en/naturalness.md)

La librería no reproduce animaciones grabadas: todo el movimiento es procedural. Pero que se vea natural
se puede **medir**. Para eso se compara con capturas de movimiento reales de la
[base de datos de CMU](https://mocap.cs.cmu.edu): se analiza la marcha de las personas y la del
personaje de la misma manera, a la misma velocidad relativa, y se comparan curva a curva.

## Cómo se compara

- **Puntos del cuerpo, no huesos**: caderas, rodillas, tobillos, base de los dedos, hombros, codos,
  muñecas, pelvis, base del cuello y cabeza. Así el análisis es igual para el esqueleto de CMU y para
  cualquier rig de la librería (`tests/helpers/gaitAnalysis.ts`).
- **Eventos** (método de Zeni et al., 2008): apoyo de talón = tobillo más adelantado respecto a la
  pelvis; despegue = punta más atrasada. Cada ciclo va de un apoyo al siguiente del mismo pie y se
  normaliza a 0–100 %. Los dos lados se promedian.
- **Misma velocidad relativa**: el personaje camina con el mismo número de Froude (v² / (g·pierna)) que
  la persona. Las longitudes se miden en largos de pierna.
- **Qué se mide**: cadencia, zancada, fracción de apoyo y de doble apoyo, ancho de paso, holgura de la
  punta; y, a lo largo del ciclo, muslo, rodilla, tobillo, inclinación del pie, alturas del tobillo y de la
  punta, posición del tobillo respecto a la cadera, altura y vaivén de la pelvis, su rotación, caída
  lateral y basculación, rotación e inclinación lateral de los hombros, tronco, brazo (también en el plano
  frontal), antebrazo, codo y muñeca.
- **Hueso por hueso**: `tests/tools/boneInventory.ts` mide cuánto gira cada hueso, en los ejes del
  personaje, frente a CMU y SFU ([inventario de huesos](bone-inventory.md)).

## Usarlo

Las capturas no se versionan (licencia de terceros). Se descargan a `recursos/mocap-cmu/`
(ignorada por git) desde `https://mocap.cs.cmu.edu/subjects/<sujeto>/<archivo>`:

| Sujeto | Archivos | Contenido |
|---|---|---|
| 35 | `35.asf`, `35_01.amc`, `35_02.amc`, `35_03.amc`, `35_17.amc`, `35_18.amc` | caminar; trotar |
| 16 | `16.asf`, `16_15.amc`, `16_17.amc`, `16_33.amc` | caminar; giro de 90°; caminar lento y parar |
| 07 | `07.asf`, `07_04.amc`, `07_12.amc` | caminar lento; caminar rápido |
| 17 | `17.asf`, `17_01.amc`, `17_03.amc`, `17_06.amc`, `17_08.amc` | estilos: enojado, sigiloso, alegre, corpulento |
| 36, 39, 47 | `36.asf`, `36_02.amc`, `36_03.amc`, `36_09.amc`, `39.asf`, `39_11.amc`, `47.asf`, `47_01.amc` | ir, dar la vuelta y volver |
| 69 | `69.asf`, `69_06.amc`, `69_07.amc`, `69_08.amc`, `69_13.amc` | caminar y dar la vuelta (repetido); girar en el sitio |
| 144, 13, 14, 81, 22 | `144.asf`, `144_22.amc`–`144_25.amc`, `13.asf`, `13_10.amc`, `13_12.amc`, `14.asf`, `14_07.amc`–`14_09.amc`, `81.asf`, `81_10.amc`, `22.asf`, `22_18.amc` | alcanzar a los lados y arriba; empujar algo alto; apoyar las manos (para tocar al pasar) |
| 83, 111, 113, 114, 143 | `83.asf`, `83_27.amc`–`83_32.amc`, `83_34.amc`, `83_35.amc`, `111.asf`, `111_27.amc`, `113.asf`, `113_19.amc`, `113_20.amc`, `114.asf`, `114_07.amc`–`114_09.amc`, `143.asf`, `143_17.amc` | escaleras: subir (83); subir y bajar (el resto; 111, 113 y 114 son mujeres embarazadas o recién paridas) |

```bash
npm run mocap                  # caminar normal: mocap frente a librería, curva a curva
npm run mocap -- 35_17         # una toma (o un tipo: walk, run, style); CURVES=1 añade las curvas
npm run mocap -- swing         # forma del pie en el aire en el mocap
npm run mocap -- referencia    # regenera tests/reference/cmu-caminar.json
```

`tests/reference/cmu-caminar.json` guarda solo las **medias por ciclo** de las cuatro tomas de caminar
normal (no los datos originales). El test `tests/naturalness.test.ts` comprueba con ellas que la marcha
de la librería no se aleje de la de una persona: si un cambio la empeora, falla.

Licencia de los datos: uso libre (también comercial), sin revender los datos, ni siquiera convertidos.
CMU pide este agradecimiento: *The data used in this project was obtained from mocap.cs.cmu.edu.
The database was created with funding from NSF EIA-0196217.*

### Capturas de SFU

Segunda fuente, **solo para medir en local**: la [base de datos de SFU](https://mocap.cs.sfu.ca) (BVH a
120 fps, en pulgadas, Y hacia arriba; lector en `tests/helpers/bvh.ts`). Se descargan a
`recursos/mocap-sfu/` (ignorada por git) desde `https://mocap.cs.sfu.ca/nusmocap/<archivo>.bvh`:

| Sujeto | Archivos | Contenido |
|---|---|---|
| 0005 | `0005_Walking001.bvh`, `0005_BackwardsWalk001.bvh` | caminar (con curvas); hacia atrás en círculo |
| 0007 | `0007_Walking001.bvh` | caminar, toma larga |
| 0008 | `0008_Walking001.bvh`, `0008_Walking002.bvh` | caminar en círculos; caminar con aire chulesco y poses |
| 0018 | `0018_Walking001.bvh`, `0018_TipToe001.bvh`, `0018_Catwalk001.bvh` | rectas con zancada creciente; de puntillas; pasarela |

```bash
npm run mocap -- sfu           # caminar normal (0005, 0007, 0008): media de los tramos rectos
npm run mocap -- 0018          # una toma (o un tipo: sfu-walk, sfu-style); CURVES=1 añade las curvas
```

El esqueleto tiene 21 huesos animados: pelvis, dos segmentos de columna (`Spine`, `Spine1`), cuello,
cabeza, clavículas, brazo, antebrazo, mano, muslo, pierna, pie y dedos del pie. La rodilla, el codo y
los dedos del pie giran en un solo eje. No tiene dedos de la mano: `HandThumb` y `*_Wrist_End` no se
mueven. Tiene menos huesos que el de CMU: lo que aporta son otras personas y otras formas de caminar.

Licencia de los datos: **solo para investigación**. No se pueden usar en productos comerciales ni
revenderse. Por eso de SFU no se guarda nada en el repo (ni medias, como con CMU) y ningún valor por
defecto sale solo de SFU: confirma o desempata lo que dicen CMU y la literatura clínica. SFU pide este
agradecimiento: *The data used in this project was obtained from http://mocap.cs.sfu.ca. The database
was created with funding from NUS AcRF R-252-000-429-133 and SFU President's Research Start-up Grant.*

Lo que se vio al compararla con CMU:

- **Casi todo es caminar en curva**: 0005 y 0008 giran más de 20 °/s casi todo el tiempo y 0007 tiene un
  solo tramo recto (un ciclo). El análisis de marcha supone una línea recta, así que solo se usan los
  tramos con menos de 12 °/s de giro durante 2 s o más. Para la marcha en recta sirve sobre todo 0018;
  las tomas en curva servirán para los giros.
- **0018 cambia de zancada a cadencia fija** (es lo que se le pidió): ~121 pasos/min a 1,1 y a 1,4 m/s, con
  la zancada de 1,35 a 1,72 piernas. No sirve para ver cómo cambia la cadencia con la velocidad.
- **Rodilla casi recta en el apoyo** (1–7°, como en la literatura clínica y en el sujeto 07 de CMU; los
  sujetos 35 y 16 de CMU no bajan de 13°). Confirma que el desfase de la rodilla es de la calibración
  de esos esqueletos.
- Entre personas varía mucho el ancho de paso (0,12–0,24 piernas), la caída lateral de la pelvis
  (±4,6° en 0007, ±8,9° en 0018; CMU ±5°) y el codo (SFU lo lleva casi estirado, CMU a 20–35°).

## Resultados (caminar a 1,2 m/s)

Error cuadrático medio de cada curva frente a la media del mocap, antes y después de ajustar la
librería con estas mediciones:

| | mocap | antes | ahora |
|---|---|---|---|
| Cadencia (pasos/min) | 105 | 121 | 107 |
| Zancada (× pierna) | 1,60 | 1,39 | 1,57 |
| Apoyo / doble apoyo | 0,62 / 0,24 | 0,64 / 0,28 | 0,63 / 0,27 |
| Holgura de la punta (× pierna) | 0,031 | 0,114 | 0,037 |
| Muslo | — | 8,4° | 4,7° |
| Rodilla | — | 13,1° | 7,5° |
| Tobillo | — | 22,6° | 4,0° |
| Inclinación del pie | — | 23,1° | 4,7° |
| Brazo | — | 11,4° | 4,3° |
| Codo | — | 13,7° | 5,3° |
| Basculación de la pelvis | ±1,8° | 1,3° | 0,2° |

Qué cambió, y por qué:

- **Cadencia ∝ √velocidad.** En el mocap la cadencia sigue f ≈ 1,6·√v pasos/s (el resto de la
  velocidad lo pone la longitud del paso). Antes crecía en línea recta y los pasos eran cortos y rápidos.
- **Caminar hasta ~2 m/s.** Antes la transición a correr empezaba en 1 m/s: a una velocidad normal
  (1,2–1,4 m/s) el personaje ya corría a medias (rodillas altas, codos doblados). Ahora `walkSpeed`
  (1,4) es la velocidad normal y la transición empieza en `runStartSpeed` (1,7), con el punto medio
  hacia 2 m/s (Froude ≈ 0,5), como en las personas.
- **Pie en el aire** (`evaluateSwing`): sale con la velocidad del despegue, llega a lo más alto poco
  después y baja planeando; la punta se levanta de forma gradual y aterriza de talón con ~20° (antes
  subía primero en el sitio, iba alto todo el swing y aterrizaba casi plano).
- **Rodado del pie**: el talón empieza a subir hacia la mitad del apoyo y despega con ~55° (antes 25°),
  girando sobre la articulación de los dedos, que se doblan y quedan apoyados (antes el pie giraba rígido
  sobre un punto del suelo y los dedos se clavaban en él). El swing sale de la pose exacta del despegue.
- **Apoyo más atrás** (`walkLandingLead`): el pie aterriza algo más cerca y la pierna de atrás se
  estira antes de despegar, como en el mocap (antes el apoyo quedaba centrado). Depende de que el talón
  se levante: con los pies planos (p. ej. `heelLiftAngle` bajo) el apoyo vuelve a centrarse.
- **Rodillas**: casi rectas de pie (`standKneeBend`), amortiguan al recibir el peso y la flexión crece
  con la velocidad.
- **Brazos**: balanceo algo más hacia atrás que hacia delante, que crece con la velocidad, en fase con
  las piernas, y codos más doblados.
- **Pies algo más juntos** que las caderas al caminar (80 % de su anchura).
- **Suavidad**: al despegar, las caderas suben siguiendo un muelle (nunca por encima de lo que permiten
  las piernas) y la cadencia cambia de forma continua; al aterrizar, cada pie fija su apoyo según la
  velocidad más alta entre la actual y la que habrá al despegar. Los tirones de caderas bajaron a la
  mitad o menos en todo el rango.
- **Basculación de la pelvis** (`pelvisTiltSwing`): bascula hacia delante al apoyar cada talón y hacia
  atrás a mitad del apoyo, dos veces por zancada, ±1,8° como en CMU (antes su inclinación era fija). La
  columna baja la absorbe, así que el tronco y la cabeza no cabecean con ella. Pasa por un muelle: al
  parar o saltar entra y sale suave.
- **Parada**: al pararse da un paso de cierre y queda con un pie algo adelantado (hasta un 20 % de
  `stepLength`) en vez de dar otro de 6–15 cm para cuadrar los pies. Giro y caída de la pelvis pasan de la
  onda de la marcha a la postura de parado con la velocidad, así que al quedar quieto la pelvis no vuelve
  de golpe al centro (sacudía el tronco y los brazos a ~60 °/s). Y el codo ya no se dobla de más al
  frenar ni se endereza en un frame al quedar quieto (latigazo de hasta 540 °/s). Al echar a andar desde
  parado, el pie apoyado ya no salta a la pose de aterrizar de talón, y un pie planificado corriendo que
  aterriza ya caminando baja la punta desde el ángulo con que terminó el swing (antes la punta saltaba
  ~16° en un frame).
- **Compensación lateral repartida** (`chestRollShare`): la caída de la pelvis la deshacen la columna
  baja y el pecho (~1/3, como en CMU), en vez de solo la columna baja. Los hombros quedan igual de
  rectos y la espalda se curva en vez de doblarse en un punto. A cambio, la cabeza se va algo más de
  lado a lado (5,3 cm en Mixamo, 5,6 en Rigify; en CMU, 4,8–5,3).

## Vueltas

`tests/tools/turnReport.ts` mide cada vuelta igual en el mocap y en la librería (con
`tests/helpers/turnAnalysis.ts`): ángulo, duración (del 10 al 90 % del giro), pasos, giro de cada paso,
cuánto pivota el pie apoyado, velocidad mínima y cuánto se aparta la pelvis de la línea de llegada.

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/turnReport.js
```

En CMU hay dos maneras de dar la vuelta (180°): casi parado, pivotando (sujeto 36: 3–5 pasos de 55–124° en
1,1–1,9 s, apartándose 3–18 cm), o sin pararse del todo, en una curva muy cerrada (sujeto 69: 0,3–0,5 m/s,
2–3 pasos de ~115°, 40–80 cm). En las dos, cada pie aterriza ya girado y el pie apoyado apenas pivota
(~10°); al aterrizar, el pie va 31° (mediana; máximo 54°) por delante de la pelvis. Los giros de hasta
~120° los hacen sin dejar de caminar (CMU 16_17: 90° en 0,5 s a 0,57 m/s).

`moveTo` hacia un destino detrás (modelo Mixamo; caminando a 1,4 m/s y el destino 4 m detrás):

| | CMU | antes | ahora |
|---|---|---|---|
| Duración del giro | 1,1–1,9 s | 2,5–2,8 s | 1,1 s |
| Pasos de giro | 2–3 (media 3,3) | 7–8 | 2–3 |
| Giro de cada paso | ~100–140° | 45–56° | 94° (desde parado, 114°) |
| Cuánto se mueve el pie en cada paso | — | 11–29 cm (se pisaban) | 54–75 cm |
| Velocidad mínima | 0,3–0,5 m/s (sujeto 69) | 0,1 m/s | 0,40–0,43 m/s |
| Se aparta de la línea | 3–80 cm | 1,8–5,2 m | 27 cm |
| Rodillas, lo más cerca | — | — | ≥ 15 cm |

Cómo: con el destino a más de 120°, `moveTo` frena hasta ~0,3 × walkSpeed (no del todo: así cada paso ya
se desplaza hacia la nueva dirección) y sube los límites de giro del cuerpo (× 2,5) y de cada paso (× 2,5),
más cuanto más despacio va (llegando deprisa, primero frena: girando a 150 °/s todavía lanzado se cruzaban
las piernas). Con el destino casi justo detrás gira hacia el lado del pie que despega a continuación, que
abre la vuelta; por el otro lado, ese pie cruzaba por delante de la pierna de apoyo y las rodillas chocaban.
Para los pies:
- el apoyo se estima con el giro que llevará el cuerpo al aterrizar (no con el del despegue, casi nulo al
  empezar a pivotar) y el pie aterriza como mucho 30° por delante del cuerpo;
- el pie apoyado solo pivota cuando el cuerpo ya lo ha pasado, a 360 °/s como mucho, y al pivotar la cadera
  admite 45° de torsión antes de girarlo (una persona, 31° de mediana al aterrizar y hasta ~54°);
- en un paso que gira mucho el pie, si la línea recta pasaría por encima del pie apoyado, el swing lo rodea
  por su propio lado (`swingDetour`). Solo si pasa cerca en la parte central del swing (20–80 %) y como
  mucho 0,2 × stepLength: el desvío entra con sen²(π·t) y, si el punto más cercano caía junto al despegue
  o al aterrizaje, para notarse tenía que ser enorme (hasta 1,35 piernas) y la pierna en el aire se estiraba
  de lado, con el tobillo a 1,29 piernas de la cadera. Ahora, en vueltas de 125–170° a los dos lados,
  caminando o desde parado, el desvío no pasa de 0,18 piernas ni el tobillo de 0,56 piernas de la cadera.

El primer paso: recibiendo la vuelta caminando deprisa, el pie que ya estaba en el aire aterrizaba con la
zancada entera (147 cm a 1,4 m/s), porque su aterrizaje se decidía al despegar. Ahora, si la velocidad
pedida baja mucho en la primera parte del swing, se vuelve a planificar (`retargetSwing`: el final pasa del
de antes al nuevo con un smoothstep, sin salto de posición ni de velocidad), y al empezar la vuelta frena
1,6 × más que al pararse. Queda en 118 cm, 0,8 veces la zancada (CMU: 0,68–0,95), y cae 15 cm por delante de
la pelvis (CMU: 20–28). Lo mismo acorta el último paso de una parada brusca.

La salida: al terminar la vuelta pasaba de golpe a la velocidad de crucero; el pie que había pivotado se
quedaba atrás con la pierna estirada (el tobillo a 0,7 piernas de la pelvis; caminando, 0,4–0,5) y el
paso siguiente medía 1,88 piernas (caminando, 1,58–1,68). Ahora sale acelerando a 0,45 × `acceleration`
hasta su velocidad de crucero, en 3 pasos (1,17 → 1,54 → 1,65 piernas), como en CMU, y el pie que estaba
en el aire al acabar la vuelta se replanifica también cuando la velocidad pedida sube.

Por debajo de 120°, la curva de antes.

## Tocar al pasar

Ni CMU ni SFU tienen a alguien caminando y tocando una pared, una columna o una baranda (en SFU, lo más
parecido son saltos de valla con apoyo de manos). Lo que sí hay en CMU son alcances: el sujeto 144 alcanza a
izquierda y derecha objetivos a distintas alturas (144_22–25), además de "reach for" (13_10, 14_07–09) y
empujar algo alto (81_10). `tests/tools/reachReport.ts` mide cada alcance (de quieta a quieta, la muñeca respecto
a la pelvis) desde el brazo colgando:

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/reachReport.js
```

| Alcances del sujeto 144 (30) | Mediana | p10–p90 |
|---|---|---|
| Duración | 0,76 s | 0,65–0,82 s (más 3 de 2–5 s, con pausas) |
| Velocidad máxima de la muñeca | 3,75 brazos/s | 3,2–4,5 |
| … en qué momento del gesto | 47 % | 36–62 % |
| Muñeca a mitad (distancia al hombro / brazo) | 0,71 | 0,59–0,82 |
| Muñeca al final | 0,98 | 0,96–0,99 |
| Codo al final | 158° | 147–168° |
| Curvatura del recorrido (desvío / distancia) | 0,14 | 0,09–0,29 |
| Tronco hacia el objetivo (/ brazo) | 0,03 | −0,05–0,43 (los objetivos bajos) |
| Vuelta a colgar (`RETURN=1`, 29) | 0,68 s, pico al 51 % | desde 0,61 s |

De ahí sale el gesto: la mano va del balanceo a la superficie en `touchReachTime` (0,75 s) con un minimum jerk
(Flash y Hogan; pico al 50 % en vez de al 47 %), por un recorrido curvado un 12 % hacia fuera del hombro; el codo
se dobla a mitad sin que haga falta pedirlo (la línea recta del brazo colgando al objetivo pasa cerca del hombro).
Vuelve en `touchReleaseTime` (0,65 s). El tronco no acompaña: las superficies que busca están entre la cadera y el
pecho.

Lo que el mocap no decide, y está elegido a mano:

- **Lo cerca que toca**: los alcances de CMU van lo más lejos posible (brazo al 98 %); tocar al pasar no. Elige
  superficies a las que llegue con el brazo al 75 % (codo ~110°) y como mucho al 82 % (`touchMaxReach`), y
  suelta si tendría que pasar del 93 %. El vaivén de la marcha mueve el hombro ±3–4 cm, que no se puede prever
  sin la fase del paso: con más margen, la mano llegaba con el brazo recto y soltaba enseguida.
- **Cuándo**: empieza cuando el hombro, a la velocidad de ahora, quedará a su lado al terminar el gesto, con el
  punto un 20 % del brazo por delante; suelta cuando el punto queda un 15 % por detrás (o, parado, tras
  `touchHoldTime`).
- **La palma** mira la superficie y los dedos van hacia donde menos gira la muñeca respecto a como la lleva el
  balanceo (prueba 12 direcciones con el brazo ya resuelto): arriba en una pared al lado, hacia fuera en una
  baranda. Con los dedos siempre hacia arriba, una pared a la derecha pedía girar la palma ~180° respecto al
  antebrazo.
- **El codo** apunta abajo y atrás, conservando la mitad de hacia donde ya se doblaba (con la mano en una baranda
  ya pasada, "abajo y atrás" va casi por el brazo).

**Deslizar la mano.** Caminando junto a una pared o una baranda, la mano apoyada se desliza mientras siga al
lado. Tampoco hay mocap de esto; está elegido para que se vea como una mano que roza la pared:

- un muelle crítico (1,5 Hz) lleva el punto de apoyo hacia el lado del hombro (un 10 % del brazo por delante),
  solo a lo largo de la superficie y en el sentido de la marcha (el vaivén del cuerpo no la mueve), con la
  velocidad del cuerpo en el amortiguador para que no se quede atrás; esa velocidad entra en 0,15 s (de golpe, la
  mano arrancaba con ~28 m/s²) y nunca desliza hacia atrás (si tocó por delante, espera al cuerpo);
- un rayo corto la vuelve a pegar a la superficie cada frame; con la normal suavizada (0,1 s), la mano gira con
  ella en un muro curvo amplio;
- en una pared baja poco a poco (0,6 s) a algo más de medio brazo por debajo del hombro: apoyada mientras camina
  a la altura del pecho, con el brazo casi horizontal, parecía un ala;
- deslizando, el brazo puede ir hasta el 97 % (al tocar, el 93 %): en una baranda a la altura de la cadera la mano
  se apoya con el brazo casi recto, y la distancia cambia despacio;
- se acaba (y suelta) si el rayo no encuentra la superficie, si la normal gira de golpe (una esquina) o si la
  superficie es muy curva (la normal gira más de 1 rad por brazo recorrido, radio < ~0,5 m: una columna). En
  una columna, rodeándola, la mano no podía seguir al cuerpo y el brazo se estiraba de lado hasta soltar de golpe
  (hasta 10 °/frame²); ahora la toca y la suelta al pasar;
- la vuelta parte de donde está la muñeca de verdad y con la velocidad que lleva (tras el IK), no del punto
  pedido: si el punto ya quedaba fuera de alcance, partir de él frenaba el brazo de golpe.

Medido (`tests/touch.test.ts` y a mano, a 0,8, 1,2 y 1,5 m/s, a los dos lados, en los dos modelos): por una pared
de 8 m o una baranda la mano va apoyada hasta el final (6–8 m caminando), con el centro de la palma a menos de 1 mm
de la superficie; la mayor aceleración angular del brazo, 0,5–2,2 °/frame² (el pico, al alcanzar).

Sin tirones: los tests (`tests/touch.test.ts`) piden menos de 2 °/frame² en brazo, antebrazo y mano a lo largo
de todo el gesto (2,5 deslizando; caminando sin tocar, ~0,4); hoy, 0,5–2,2 en columnas, paredes y barandas a los
dos lados, en los dos modelos. La mano apoyada sin deslizar no se mueve (< 1 mm). Lo que costó llegar ahí, por si
vuelve a aparecer:

- el brazo colgando va casi recto (99 % del brazo) y el objetivo, al adelantarse, se pasaba del alcance: el IK lo
  estiraba del todo, donde el codo cambia muy deprisa con la distancia. La distancia al hombro se satura (desde
  la extensión del balanceo hasta el 92 % del brazo con el gesto);
- la orientación de la mano se mezcla respecto al antebrazo como quedará con la mano apoyada (un IK aparte), no
  en world ni respecto al antebrazo colgando, y siempre por el mismo lado (con el signo de los cuaterniones
  continuo de un frame a otro);
- al soltar, la mano pasa de quieta en la superficie a ir con el cuerpo poco a poco (con el punto fijo, el cuerpo
  se alejaba mientras volvía y el brazo daba un latigazo hacia atrás);
- el IK del brazo recibe el eje de la bisagra del codo tal como lo dobla el balanceo (si lo deducía del punto
  hacia el que apunta el codo, la torsión del antebrazo cambiaba de un frame a otro).

## Escaleras

Las tomas de escaleras de CMU son tramos cortos (2–3 escalones de unos 12–19 cm; las medidas no están
documentadas: salen de la altura a la que el tobillo se queda quieto). Cada swing se clasifica en subir, bajar o
llano, y se compara con la librería en una escalera de 17 × 28 cm:

| | Mocap, subir | Mocap, bajar | Librería, subir | Librería, bajar |
|---|---|---|---|---|
| Altura del pie a mitad del swing (fracción del desnivel; < 0: por encima del inicio) | 1,48 | −0,33 | 1,8 | −0,5 |
| Altura del pie al 75 % del swing | 1,33 | 0,60 | 1,6 | −0,3 |
| Ángulo del pie al apoyar (°, + punta arriba) | 0 | −3 | 0 | 0 |
| Inclinación del tronco respecto al llano (°) | +7 | +2,5 | +7 | +2,4 |
| Flexión máxima de la rodilla de apoyo (°) | 55 | 68 | ≈ 80 | ≈ 95 |

Lo que se cambió a partir de esto: en un escalón el pie apoya plano (en llano apoya de talón, con la punta
arriba); al bajar, primero avanza por encima del borde y luego baja (antes bajaba desde el principio y cortaba
el borde); y el tronco se inclina hacia delante según la pendiente de la escalera. Al bajar, la librería baja
más tarde que el mocap: espera a que la parte de atrás del talón haya pasado el borde. La rodilla de apoyo se
dobla más que en el mocap: la altura de las caderas la limita la pierna de atrás, que llega a la huella de
abajo; pendiente.

## Saltos de pose

`tests/tools/popProbe.ts` mide la aceleración angular de cada hueso (°/frame²) en un recorrido con
arranque, parada, giro, carrera, salto y agacharse, y lista los mayores picos con el estado de la marcha:

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/popProbe.js
```

Sirve para encontrar movimientos bruscos que una captura de pantalla no muestra (un hueso que salta un
frame y vuelve).

## Lo que el mocap de CMU no decide

- **Rodilla**: en CMU va ~10° más doblada en todo el ciclo que en la literatura clínica (desfase típico
  de los esqueletos calibrados con marcadores). Se usa su forma, no su valor.
- **Caída lateral de la pelvis**: CMU pone el máximo ~25 % del ciclo más tarde que la literatura
  clínica (Kadaba); se sigue la clínica.
- **Rebote vertical**: el sujeto de CMU sube y baja ~2,4 cm; la clínica da 4–5 cm. La librería queda en
  medio (~4 cm).
- **Tronco y cuello**: dependen de la pose de reposo de cada esqueleto; no se comparan.

## Pendiente

- **Correr**: con dos tomas de trote (un ciclo cada una) y la literatura se ajustaron la inclinación,
  los codos, los brazos (más atrás) y el talón; la cadencia (174 pasos/min a 3 m/s) se dejó dentro del
  rango de la literatura (160–180), algo por encima de la del sujeto de CMU (160), porque con menos pasos
  las caderas caían de más al girar corriendo. El pie en el aire todavía se adelanta demasiado al cuerpo
  antes de aterrizar (muslo hasta ~65° hacia delante; en el mocap, ~38°): necesita rediseñar la
  trayectoria del swing de carrera.
- **Brazo**: llega adelante algo tarde (58 % del ciclo; en el mocap, 51 %): su objetivo sale de la
  separación de los pies, que no cambia en el doble apoyo.
- **Estilos**: las tomas del sujeto 17 (enojado, sigiloso, alegre, corpulento) sirven para ajustar los
  estilos predefinidos con el mismo método.
