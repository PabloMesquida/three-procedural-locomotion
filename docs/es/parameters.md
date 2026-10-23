# Referencia de parámetros

[English](../en/parameters.md)

<!-- Generado por scripts/gen-docs.mjs a partir del código. No editar a mano: `node scripts/gen-docs.mjs`. -->

119 parámetros. Se pasan al crear el personaje (`config`) o en ejecución (`human.setConfig`); todos son
opcionales y se validan (nombre, número finito y rango).

- **↔** = longitud del cuerpo: se multiplica por `bodyScale` (tamaño del personaje respecto al de referencia de 1,83 m).
- **⚑** = solo se aplica al crear el personaje.
- Con `speedScale: 'auto'` (por defecto), además velocidades y duraciones × √bodyScale y ritmos ÷ √bodyScale (semejanza dinámica, ver la [guía](guide.md#tamaño-del-personaje)); aceleraciones y ángulos no se escalan. Con `'off'`, solo las longitudes.

## Velocidad y arranque

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `walkSpeed` | 1.4 | Velocidad normal de caminar (m/s): la de crucero al navegar caminando y a la que se dan `stepFrequency` pasos por segundo. Se puede caminar más deprisa, hasta `runStartSpeed`. |
| `runSpeed` | 3.0 | Velocidad máxima corriendo (m/s). |
| `runStartSpeed` | 1.7 | Velocidad a partir de la cual empieza la transición a correr (m/s). Una persona pasa a correr hacia los 2 m/s (número de Froude v²/(g·pierna) ≈ 0,5); por debajo camina, aunque sea a paso vivo. |
| `runTransition` | 0.6 | Margen de velocidad (m/s) por encima de runStartSpeed en el que se pasa gradualmente de caminar a correr. |
| `acceleration` | 1.5 | Aceleración al arrancar (m/s²). |
| `deceleration` | 2.5 | Deceleración al frenar (m/s²). |
| `speedEasing` | 0.35 | Suavizado de los cambios de velocidad (s): tiempo en que la aceleración o la frenada crecen hasta su máximo y vuelven a cero (curva en S). 0 = ritmo constante, sin suavizar. |

## Paso (caminando)

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `stepFrequency` | 1.9 | Pasos por segundo (contando ambos pies) a `walkSpeed`. Caminando, la cadencia crece con la raíz cuadrada de la velocidad (como en las capturas de movimiento): el resto lo pone la longitud del paso. |
| `minStepFrequency` | 1.4 | Pasos por segundo a velocidad casi nula (al arrancar, parar o recolocarse). |
| `stepLength` ↔ | 0.8 | Longitud máxima de un paso (m): si hiciera falta más, se aumenta la frecuencia. |
| `stepWidth` ↔ | null | Separación lateral entre pies (m). `null` = el 80 % de la anchura de las caderas del rig (separación de los muslos), como al caminar. |
| `stepHeight` ↔ | 0.045 | Altura máxima del pie durante el swing (m). |
| `dutyFactor` | 0.61 | Fracción del ciclo que cada pie pasa apoyado al caminar (> 0,5: doble apoyo). |
| `walkLandingLead` | 0.8 | Caminar: fracción del adelanto normal con la que aterriza el pie (0–1). Con 1, el apoyo queda centrado en la posición neutra; menos, más atrás: la pierna de atrás se estira con el talón levantado antes de despegar y la de delante aterriza más cerca, como en las capturas de movimiento. Se aplica entero con el talón levantado 45° o más al despegar (`heelLiftAngle`); con menos, el apoyo se acerca al centrado (con los pies planos la pierna de atrás no puede estirarse tanto). |
| `liftFraction` | 0.22 | Fracción del ciclo, al final del apoyo, en la que el talón se levanta (LIFT; como mucho el 30 % del apoyo). Empieza antes de que aterrice el otro pie, como al caminar de verdad. |
| `plantFraction` | 0.08 | Fracción del ciclo, al inicio del apoyo, en la que el pie termina de apoyarse (PLANT). |
| `heelLiftAngle` | 55 | Ángulo máximo del talón al despegar, pivotando sobre la punta (grados). |
| `heelStrikeAngle` | 20 | Ángulo de la punta levantada al aterrizar de talón (grados). |
| `standKneeBend` | 5 | Flexión de las rodillas de pie (grados; si el modelo las tiene más dobladas en reposo, la de reposo). |
| `stanceKneeBend` | 12 | Flexión de la rodilla de apoyo al aterrizar y a mitad del apoyo, caminando a `walkSpeed` (grados). Crece con la velocidad (desde `standKneeBend` parado), como en las capturas de movimiento: a paso vivo las rodillas amortiguan más y las caderas suben y bajan menos. |
| `loadingKneeBend` | 14 | Flexión extra de la rodilla al recibir el peso tras aterrizar (amortiguación), caminando a `walkSpeed` (grados; crece con la velocidad). |

## Correr

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `runStepFrequency` | 2.9 | Correr: pasos por segundo a runSpeed. |
| `runStepLength` ↔ | 1.2 | Correr: longitud máxima de paso (m). |
| `runDutyFactor` | 0.35 | Correr: fracción del ciclo con el pie apoyado (< 0,5: fase de vuelo). |
| `runStepHeight` ↔ | 0.15 | Correr: altura del pie en el aire (m). |
| `runHeelLiftAngle` | 45 | Correr: ángulo del talón al despegar (grados). |
| `runHeelStrikeAngle` | 2 | Correr: ángulo de la punta al aterrizar (grados; pequeño = apoyo de medio pie). |
| `runCrouch` ↔ | 0.08 | Correr: cuánto bajan las caderas en promedio (m). |
| `runBounce` ↔ | 0.03 | Correr: amplitud del rebote vertical de las caderas (m). |
| `runLandingLead` | 0.6 | Correr: fracción del adelanto normal con la que aterriza el pie (0–1). Al caminar el pie aterriza a medio apoyo por delante de la cadera; corriendo, más cerca del cuerpo (y despega más atrás, empujando). |
| `runLean` | 10 | Correr: inclinación del torso hacia delante (grados). |
| `runArmAbduction` | 9 | Correr: separación del brazo respecto a la vertical (grados). |
| `runElbowBend` | 95 | Correr: flexión del codo (grados). |
| `runArmSwing` | 25 | Correr: balanceo máximo del brazo (grados). |
| `runElbowSwingBend` | 10 | Correr: flexión extra del codo con el brazo hacia delante (grados). |

## Postura

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `walkLean` | 0 | Inclinación del torso hacia delante de pie y caminando (grados; al correr pasa a `runLean`). |
| `ankleBack` ↔ | 0.03 | Cuánto queda el tobillo por detrás de la cadera en la posición neutra del pie (m): de pie, el peso cae sobre el medio del pie, por delante del tobillo. No se toma de la pose de reposo del modelo, que puede tener los pies adelantados o retrasados. |

## Agacharse

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `crouchDepth` ↔ | 0.32 | Agachado: cuánto bajan las caderas (m). |
| `crouchHipBack` ↔ | 0.06 | Agachado: cuánto retroceden las caderas para mantener el equilibrio (m). |
| `crouchPelvisTilt` | 15 | Agachado: inclinación de la pelvis hacia delante (grados). |
| `crouchLean` | 20 | Agachado: inclinación adicional del torso hacia delante (grados). |
| `crouchElbowBend` | 35 | Agachado: flexión adicional del codo (grados). |
| `crouchArmForward` | 15 | Agachado: adelanto de los brazos (grados). |
| `crouchMaxSpeed` | 0.8 | Agachado: velocidad máxima (m/s). |
| `crouchRate` | 1.8 | Rapidez con la que se agacha o se levanta (fracción de agachado por segundo). |

## Salto

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `gravity` | 9.81 | Gravedad (m/s²). |
| `jumpSpeed` | 3.2 | Salto: velocidad vertical al despegar (m/s). |
| `jumpCrouch` ↔ | 0.12 | Salto: cuánto se hunden las caderas al prepararse (m). La duración de la preparación se deriva de esto y de jumpSpeed: las caderas bajan desde parado y suben hasta despegar justo a la velocidad del salto. |
| `jumpToeOff` | 30 | Salto: elevación de talones al final de la preparación (impulso con la punta, grados). |
| `jumpTuck` ↔ | 0.22 | Salto: cuánto se recogen los pies en el aire (m). |
| `jumpLandingPrep` | 0.22 | Salto: tiempo antes de tocar el suelo en que las piernas se extienden hacia el aterrizaje (s). |
| `landingAbsorb` | 0.05 | Aterrizaje: hundimiento de caderas por cada m/s de velocidad de caída (m por m/s). |
| `maxLandingDip` ↔ | 0.25 | Aterrizaje: hundimiento máximo de caderas (m). |
| `landingTime` | 0.45 | Aterrizaje: duración de la amortiguación (s). |

## Pararse

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `idleArmAbduction` | 10 | Parado: separación del brazo respecto a la vertical (grados; brazos más caídos que caminando). |
| `idleElbowBend` | 14 | Parado: flexión del codo (grados). |
| `idleArmForward` | -4 | Parado: ángulo del brazo por delante de la vertical (grados; negativo = hacia atrás). Un poco hacia atrás, con el codo algo doblado, la mano queda al lado del muslo y no delante. |
| `idleStepThreshold` ↔ | 0.03 | Distancia a la posición neutra por debajo de la cual un pie se considera recolocado (m). Adelante y atrás se admite más: un pie algo adelantado al pararse no se corrige con otro paso. |
| `idleTurnThreshold` | 8 | Diferencia de orientación por debajo de la cual un pie se considera recolocado (grados). |

## Giro

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `turnSpeed` | 60 | Velocidad máxima de giro (grados/s). |
| `turnAcceleration` | 240 | Aceleración angular máxima (grados/s²). |
| `maxLateralAcceleration` | 3.2 | Aceleración lateral máxima en las curvas (m/s²): a más velocidad, giro más lento (ω ≤ a / v), como un corredor que no puede girar en seco a toda velocidad. |
| `maxTurnPerStep` | 60 | Giro máximo de un pie entre dos apoyos suyos (grados): si se gira más rápido, se dan más pasos por segundo. |
| `turnSlowdown` | 0.45 | Cuánto frena para girar (0–1): fracción de la velocidad que pierde cuando le queda un giro de 180°. Menos giro pendiente, menos frena (hasta 20°, nada) y recupera la velocidad a medida que completa el giro: los cambios de dirección grandes se hacen en una curva más cerrada. |

## Reparto del peso

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `lateralShift` | 0.25 | Fracción (0–1) del camino hacia el centro de apoyo que el cuerpo se desplaza de lado. |
| `lateralShiftResponse` | 20 | Rapidez del desplazamiento lateral del cuerpo (rad/s del muelle amortiguado). |

## Pelvis

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `pelvisRotation` | 5 | Rotación máxima de la pelvis hacia el pie adelantado (grados). |
| `pelvisObliquity` | 4 | Caída lateral máxima de la pelvis del lado de la pierna en el aire (grados). |
| `pelvisTilt` | 3 | Inclinación hacia delante de la pelvis a velocidad de marcha (grados). |
| `pelvisTiltSwing` | 2 | Basculación de la pelvis en cada paso a velocidad de marcha (grados, ±): hacia delante al apoyar cada talón y hacia atrás a mitad del apoyo, dos veces por zancada (en las capturas de CMU, ±1,8°). |
| `pelvisFrequency` | 2.5 | Frecuencia natural de la pelvis (Hz): con qué rapidez sigue su giro y su caída a los pasos. Más baja = movimiento más amortiguado y con más retraso; muy alta = sigue a los pies al instante. |
| `pelvisDamping` | 0.7 | Amortiguación de la pelvis (1 = sin rebote; menos = se pasa un poco y vuelve, más suelto). |

## Torso y cabeza

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `spineCounterRotation` | 0.6 | Fracción de la rotación de la pelvis que contrarresta la columna. |
| `chestCounterRotation` | 0.6 | Fracción adicional que contrarresta el pecho (suma > 1 → hombros opuestos a la pelvis). |
| `chestRollShare` | 0.35 | Parte de la compensación de la caída de la pelvis que hace el pecho en vez de la columna baja (0–1): la espalda se curva en vez de doblarse en un punto. Los hombros quedan igual de rectos. En las capturas de CMU, ~1/3. |
| `leanPerAcceleration` | 4 | Inclinación del torso por unidad de aceleración (grados por m/s²). |
| `maxLean` | 6 | Inclinación máxima del torso por aceleración/frenado (grados). |
| `headStabilization` | 0.8 | Cuánto se estabiliza la cabeza hacia su orientación de reposo (0–1). |
| `headTurnLead` | 0.6 | Fracción del giro pendiente que la cabeza se adelanta a mirar. |
| `maxHeadTurn` | 45 | Giro máximo de anticipación de la cabeza (grados). |
| `chestTurnLead` | 0.3 | Fracción del giro pendiente que el pecho se adelanta. |
| `maxChestTurn` | 20 | Giro máximo de anticipación del pecho (grados). |
| `maxTurnLean` | 8 | Inclinación máxima hacia el interior de una curva (grados). |
| `trunkFrequency` | 4 | Frecuencia natural del tronco (Hz): con qué rapidez columna y pecho siguen a la pelvis. Más baja = tronco más pesado, que llega más tarde (el pecho, algo más que la columna). |
| `trunkDamping` | 0.6 | Amortiguación del tronco (1 = sin rebote; menos = se pasa un poco y vuelve). |
| `trunkInertia` | 0.5 | Inercia del tronco: cuánto se inclina por las aceleraciones de las caderas (grados por m/s²): hacia delante al frenar su bajada en cada paso, de lado contra el balanceo. |

## Brazos

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `idleArmAbduction` | 10 | Parado: separación del brazo respecto a la vertical (grados; brazos más caídos que caminando). |
| `idleElbowBend` | 14 | Parado: flexión del codo (grados). |
| `idleArmForward` | -4 | Parado: ángulo del brazo por delante de la vertical (grados; negativo = hacia atrás). Un poco hacia atrás, con el codo algo doblado, la mano queda al lado del muslo y no delante. |
| `armAbduction` | 6 | Separación del brazo respecto a la vertical, hacia fuera (grados). |
| `armForward` | 0 | Caminando y corriendo: ángulo del brazo por delante de la vertical alrededor del cual se balancea (grados; negativo = hacia atrás). El balanceo se centra de todos modos algo más atrás, como al caminar de verdad. |
| `elbowBend` | 22 | Flexión del codo en reposo (grados). |
| `armSwing` | 15 | Balanceo del brazo hacia delante/atrás al caminar a `walkSpeed` (grados); crece con la velocidad. El centro del balanceo queda algo por detrás de la vertical, como al caminar de verdad. |
| `elbowSwingBend` | 12 | Flexión extra del codo cuando el brazo va hacia delante (grados). |
| `armSwingFrequency` | 3.5 | Frecuencia natural del brazo (Hz): con qué rapidez sigue al balanceo que piden las piernas. Más baja = brazo más pesado y con más retraso. |
| `armSwingDamping` | 0.7 | Amortiguación del balanceo (1 = sin rebote; menos = el brazo se pasa un poco, como un péndulo). |
| `armInertia` | 2 | Inercia: cuánto se quedan atrás los brazos al acelerar (y se adelantan al frenar) (grados por m/s²). |
| `shoulderSwing` | 0.25 | Cuánto acompaña el hombro (clavícula) al balanceo del brazo, hacia delante y atrás (fracción del ángulo del brazo). |
| `shoulderDrop` | 3 | Caída del hombro por el peso del brazo relajado (grados). |
| `shoulderForward` ↔ | 0 | Cuánto queda la articulación del hombro por delante de la base del cuello, en horizontal (m; negativo = por detrás): la clavícula gira hacia atrás o hacia delante (hasta 30°) para dejarla ahí, sea cual sea la pose de reposo del modelo (algunos tienen los hombros caídos hacia delante). Menos = hombros más atrás. Necesita los huesos del cuello y del hombro. |
| `forearmFrequency` | 3 | Frecuencia natural del antebrazo (Hz): sigue al brazo como un péndulo colgado del codo. Más baja = antebrazo más suelto (se queda atrás al acelerar el brazo y sigue al frenarlo). |
| `handFrequency` | 4 | Frecuencia natural de la mano (Hz): sigue al antebrazo con algo más de retraso (muñeca suelta). |
| `fingerCurl` | 1 | Cuánto se cierran los dedos (si el rig los tiene): 0 = como en la pose de reposo del modelo, 1 = mano relajada (dedos algo doblados y juntos, pulgar hacia el índice), más = más cerrada. |
| `fingerFrequency` | 3.5 | Frecuencia natural de los dedos (Hz): siguen al balanceo de la mano con un pequeño retraso. |

## Tocar superficies

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `touchReachTime` | 0.75 | Duración del gesto de llevar la mano hasta la superficie (s). En los alcances de CMU (sujeto 144), 0,65–0,8 s desde el brazo colgando, con la velocidad en campana. |
| `touchReleaseTime` | 0.65 | Duración de la vuelta de la mano a su balanceo tras soltar (s). CMU: ~0,7 s, campana simétrica. |
| `touchHoldTime` | 0.25 | Tiempo mínimo con la mano apoyada (s). Caminando, suelta cuando el punto queda atrás. |
| `touchMaxReach` | 0.82 | Distancia máxima del hombro a la muñeca al tocar, prevista al empezar el gesto (fracción del brazo, 0–1). En CMU, al alcanzar lo más lejos posible, 0,94–0,99 (codo a 140–165°); tocar al pasar no estira tanto, y el vaivén de la marcha (±3–4 cm en el hombro) la hace llegar algo más estirada. |
| `touchCooldown` | 0.3 | Pausa tras soltar antes de volver a tocar algo por sí solo (s). |

## Variación natural

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `variation` | 1 | Variación natural (0 = todos los pasos idénticos; 1 = la de una persona): la cadencia, la inclinación del tronco, la mirada y el balanceo de cada brazo cambian un poco y despacio, de forma distinta en cada personaje (según su `seed`). |

## Point and click (moveTo)

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `arriveRadius` ↔ | 0.05 | Distancia al destino a la que se considera que ha llegado (m). |
| `maxWalkTurnAngle` | 75 | Error de rumbo a partir del cual el destino se considera muy de lado: deja de ir a su velocidad normal y gira caminando por una curva cuyo radio se limita según la distancia (no se para a girar) (grados). Más allá de 120° (detrás) ya no hace la curva: frena y gira hacia el destino en 2–3 pasos. |
| `headingLockRadius` ↔ | 0.4 | Cerca del destino deja de corregir el rumbo (evita girar alrededor del punto) (m). |
| `stopTolerance` ↔ | 0.1 | Distancia extra al destino con la que, ya parado tras frenar, se considera que ha llegado (m). |

## Avanzado: márgenes y sondas

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `toeClearance` ↔ | 0.02 | Margen mínimo entre la punta del pie y el terreno durante el swing (m). |
| `maxExtraStepHeight` ↔ | 0.3 | Altura extra máxima del swing para salvar obstáculos (m). |
| `groundProbeHeight` ↔ | 1.5 | Altura sobre la raíz desde la que se busca el suelo bajo el cuerpo (m). |
| `groundProbeDepth` ↔ | 2.5 | Profundidad bajo la raíz hasta la que se busca el suelo al caminar (m). |
| `footProbeHeight` ↔ | 0.5 | Altura sobre el tobillo deseado desde la que se busca el suelo bajo cada pie (m). |
| `footProbeDepth` ↔ | 0.6 | Profundidad bajo el tobillo deseado hasta la que se busca el suelo bajo cada pie (m). |
| `footProbeTolerance` ↔ | 0.002 | Desnivel mínimo del suelo bajo los dedos respecto al plano del talón para inclinar el pie (m). |
| `kneePoleDistance` ↔ ⚑ | 0.6 | Distancia por delante de la rodilla del punto hacia el que se dobla (pole del IK) (m). Solo al crear. |

## Estilos (presets)

Se eligen al crear (`preset: '…'`) o en ejecución (`human.applyPreset('…')`); `config` y los `overrides`
de `applyPreset` mandan sobre el estilo.

- `tired`: Cansado: pasos cortos y bajos (arrastra los pies), tronco inclinado, brazos casi quietos, reacciona despacio.
- `sneaky`: Sigiloso: lento, pasos cortos y altos con apoyo largo, tronco adelantado, brazos recogidos, cabeza muy estable.
- `athletic`: Atlético: más rápido y reactivo, zancadas largas, carrera inclinada con mucho braceo, salta más y gira rápido.
- `heavy`: Pesado: postura ancha, balanceo lateral marcado, pasos lentos y bajos, brazos separados, arranca y frena despacio.

Valores que cambia cada estilo (vacío = el de por defecto):

| Parámetro | Por defecto | `tired` | `sneaky` | `athletic` | `heavy` |
|---|---|---|---|---|---|
| `walkSpeed` | 1.4 | 0.8 | 0.7 | 1.3 | 0.9 |
| `runSpeed` | 3.0 | 2.2 | 2.5 | 4.5 | 2.4 |
| `acceleration` | 1.5 | 0.8 | 1.2 | 3 | 0.9 |
| `deceleration` | 2.5 | 1.8 | 3 | 4 | 1.5 |
| `stepFrequency` | 1.9 | 1.7 | 1.5 | 2.1 | 1.6 |
| `minStepFrequency` | 1.4 | 1.2 | 1.1 |  | 1.2 |
| `stepLength` | 0.8 | 0.55 | 0.5 | 0.85 | 0.6 |
| `stepWidth` | null |  |  |  | 0.3 |
| `stepHeight` | 0.045 | 0.023 | 0.059 | 0.054 | 0.032 |
| `dutyFactor` | 0.61 |  | 0.68 |  |  |
| `runStepFrequency` | 2.9 |  |  | 3.2 |  |
| `runStepHeight` | 0.15 |  |  | 0.28 |  |
| `runLean` | 10 |  |  | 12 |  |
| `walkLean` | 0 | 15 | 18 |  |  |
| `idleArmAbduction` | 10 | 5 | 12 |  | 18 |
| `idleElbowBend` | 14 | 6 | 40 |  |  |
| `runArmSwing` | 25 |  |  | 45 |  |
| `crouchDepth` | 0.32 |  | 0.4 |  |  |
| `crouchMaxSpeed` | 0.8 |  |  | 1.2 |  |
| `jumpSpeed` | 3.2 | 2.4 |  | 4 | 2.4 |
| `heelLiftAngle` | 55 | 15 | 30 |  |  |
| `heelStrikeAngle` | 20 | 6 | 3 |  | 8 |
| `turnSpeed` | 60 | 45 |  | 120 | 45 |
| `turnAcceleration` | 240 |  |  | 360 |  |
| `lateralShift` | 0.25 | 0.35 | 0.15 |  | 0.5 |
| `pelvisRotation` | 5 |  |  |  | 8 |
| `pelvisObliquity` | 4 |  |  |  | 7 |
| `pelvisTilt` | 3 | 5 |  |  |  |
| `headStabilization` | 0.8 | 0.5 | 0.95 |  |  |
| `armAbduction` | 6 | 8 | 16 |  | 22 |
| `elbowBend` | 22 | 8 | 45 |  |  |
| `armSwing` | 15 | 6 | 4 | 18 | 11 |
| `elbowSwingBend` | 12 | 5 | 5 |  |  |
