# Diagnóstico — fotos extra y contexto de producto

**Fecha:** 28 de julio de 2026  
**Rama de diagnóstico:** `feature/fix-fotos-contexto-conversacion`  
**Estado:** diagnóstico cerrado e implementación terminada en la misma rama,
pendiente de revisión/autorización antes de commit o despliegue.

## Resumen ejecutivo

El historial real aportado por Lili el 28 de julio precisa la secuencia:

1. El cliente respondió `"Sala"`.
2. Olivia explicó el uso de la mesa y preguntó por iniciativa propia:
   `"¿Te gustaría verla en fotos o tienes alguna duda sobre las medidas?"`.
3. El cliente respondió `"Si"`.
4. Olivia contestó `"¡Claro! Aquí te muestro cómo queda 😊"` y se enviaron
   fotos de Repisa Flotante.

Por tanto, las fotos no se dispararon directamente con `"Sala"`. El primer
problema es que Olivia **ofreció fotos adicionales sin que el cliente las
pidiera**, induciendo la respuesta afirmativa. El segundo problema sí permanece
confirmado: al procesar `"Si"`, el selector perdió el producto de la
conversación.

El código confirma dos defectos independientes:

1. El backend acepta `[FOTOS_EXTRA]` emitido por Claude sin comprobar que el
   cliente haya solicitado fotos de forma explícita. En el incidente real hubo
   un consentimiento afirmativo, pero fue provocado por una oferta innecesaria
   de Olivia. El prompt permite o fomenta esa oferta en algunos flujos.
2. Cuando se decide enviar fotos en un turno posterior, el producto se vuelve a
   detectar desde cero usando únicamente `[texto_del_turno, respuesta_de_Claude]`.
   No se consulta el historial, el `referral_data`, el formulario vinculado ni
   un producto persistido para la conversación. Si esos dos textos no nombran un
   producto, la detección devuelve `null` y el flujo fuerza el fallback
   `Repisa Flotante`.

La combinación reproduce el incidente: Olivia ofrece fotos sin que se las
pidan; luego el cliente responde solamente `"Si"` y, al no aparecer
`"Mesa Auxiliar"` ni en esa respuesta ni necesariamente en la contestación
breve de Claude, el selector cae a repisa.

## Evidencia en el flujo

### 1. Quién puede activar fotos extra

En `procesarMensaje()`:

- `necesitaFotosExtra` empieza como el resultado de buscar `[FOTOS_EXTRA]` en
  la respuesta de Claude (`whatsapp_agent.js:3541`).
- Solo si Claude no puso el tag y no escaló se evalúan palabras clave del
  mensaje del cliente (`whatsapp_agent.js:3542-3549`).
- No existe una validación posterior que exija intención explícita del cliente
  antes de obedecer el tag del modelo.

El texto `"Si"` tampoco coincide con las palabras clave del backend (`foto`,
`imagen`, `cómo queda`, `cómo se ve`, `muéstrame`, `ver la repisa`). La
respuesta visible de Olivia coincide exactamente con la respuesta que el prompt
ordena usar para fotos de repisa, salvo por el tag interno que se limpia antes
de enviar al cliente. Esto constituye evidencia fuerte de que Claude respondió:

```text
¡Claro! Aquí te muestro cómo queda 😊 [FOTOS_EXTRA]
```

La atribución puede cerrarse definitivamente consultando la respuesta cruda en
logs; el historial visible no conserva el tag porque el backend lo elimina
antes de enviar el texto por WhatsApp.

### 2. Pérdida del producto entre turnos

Al enviar saludo o fotos extra, el código ejecuta:

```js
detectarProductoParaFotos([texto, respuesta]) || PRODUCTO_FOTOS_FALLBACK
```

(`whatsapp_agent.js:3564-3570`).

`detectarProductoParaFotos()` concatena exclusivamente los textos recibidos
como argumento (`whatsapp_agent.js:3705-3707`). La función no recibe número de
lead, historial, referral, formulario ni estado de conversación.

El fallback está declarado explícitamente como:

```js
const PRODUCTO_FOTOS_FALLBACK = 'Repisa Flotante';
```

(`whatsapp_agent.js:3685-3687`).

Además, `fotosParaProducto()` vuelve a caer en las fotos de repisa si recibe un
producto desconocido o nulo (`whatsapp_agent.js:3785-3789`). Existen así dos
capas que sustituyen ambigüedad por repisa en vez de detener el envío.

### 3. Mesa Auxiliar no tiene fotos adicionales

`FOTOS_POR_PRODUCTO['Mesa Auxiliar']` contiene exactamente dos fotos. La función
`seleccionarFotosExtra()` repite esas mismas dos cuando un producto no tiene
tres o más (`whatsapp_agent.js:3797-3802`).

Esto contradice la regla de negocio confirmada: si ya se enviaron las dos fotos
del saludo y no existen otras, Olivia debe explicarlo o escalar ante una
solicitud específica; no debe repetir automáticamente ni sustituirlas.

## Cobertura existente y huecos

`test/fotos-por-producto.test.js` cubre:

- detección aislada por palabras clave;
- URLs sin cruce entre catálogos;
- fallback deliberado a repisa;
- selección de fotos de saludo y fotos extra.

La suite actual incluso afirma como comportamiento esperado que un producto
desconocido/nulo cae a repisa y que Mesa Auxiliar repite sus dos fotos. Esas
pruebas validan el diseño que permite el bug.

No hay pruebas que cubran:

- la decisión completa de si se deben enviar fotos;
- un segundo turno que no repite el producto;
- recuperación del producto desde contexto de conversación;
- prohibición de mezclar productos cuando falta contexto;
- ausencia de fotos adicionales;
- escalamiento ante una foto específica inexistente.

## Evidencia de producción no disponible

La copia del repositorio no contiene logs de Railway ni exportaciones de
conversaciones. Tampoco están definidas localmente `DATABASE_URL` ni
`DATABASE_PUBLIC_URL`. Por seguridad no se intentó acceder a producción con
credenciales inexistentes.

Para cerrar la trazabilidad del incidente real se necesita el número del lead o
un rango de tiempo y consultar:

```sql
SELECT created_at, direction, sender_type, message_type, content,
       whatsapp_message_id
FROM messages
WHERE lead_id = (
  SELECT id FROM leads WHERE phone = $1
)
ORDER BY created_at ASC;
```

También conviene buscar en los logs de Railway la línea `Claude:` del mismo
turno. Si el historial almacenado limpia tags internos, el log de respuesta
cruda es la evidencia definitiva de que Claude emitió `[FOTOS_EXTRA]`.

## Causa raíz

La causa raíz no es una sola función, sino la ausencia de dos límites
determinísticos:

1. **Autorización del envío:** el backend delega al modelo la decisión de
   activar fotos extra y acepta el tag sin validar la intención del cliente.
2. **Identidad del producto:** la selección de medios es stateless por turno y
   convierte “producto desconocido” en “Repisa Flotante”.

Un ajuste únicamente al prompt reduciría la frecuencia del primer defecto, pero
no impediría que vuelva a ocurrir. Guardar únicamente `producto_actual`
resolvería continuidad, pero seguiría permitiendo fotos no solicitadas. Ambos
límites deben corregirse por separado.

## Diseño recomendado para la fase de implementación

Sin implementar todavía:

1. Extraer una decisión determinística y testeable para fotos extra. El backend
   solo debe autorizar el envío ante una solicitud explícita del cliente. El tag
   de Claude puede aportar intención o detalle, pero no ser autorización
   suficiente por sí solo.
2. Resolver el producto activo con fuentes ordenadas por confiabilidad:
   cambio explícito en el turno actual → producto persistido de la conversación
   → referral/formulario vinculado → historial reciente. Ante ambigüedad,
   **no enviar**, nunca sustituir por repisa.
3. Persistir el producto activo en `leads` o en un estado conversacional
   equivalente, actualizándolo solo ante evidencia explícita de cambio de
   producto.
4. Registrar en logs: motivo del envío, fuente del producto, producto resuelto y
   URLs seleccionadas.
5. Si la solicitud es por un detalle que no existe en el catálogo de medios,
   escalar a Lili. Si pide “más fotos” y solo existen las dos ya enviadas,
   responder que son las disponibles sin reenviarlas automáticamente.

La decisión final del esquema debe esperar la revisión de la estructura real de
`leads` y el historial del incidente, para evitar agregar una columna si ya
existe un lugar apropiado para este estado.

## Pruebas propuestas

1. Mesa Auxiliar, segundo turno `"Sala"`: responde sobre el espacio sin ofrecer
   fotos adicionales por iniciativa propia.
2. Mesa Auxiliar, turno siguiente `"Sí"` después de que el agente preguntó si
   quería fotos: recupera Mesa Auxiliar desde el contexto y nunca usa repisas.
3. Mesa Auxiliar, segundo turno `"¿tienes otra foto?"`: conserva Mesa Auxiliar;
   nunca usa repisas.
4. Producto activo no resoluble: no envía fotos y no usa fallback.
5. Cambio explícito de Mesa Auxiliar a Repisa: actualiza el producto activo y
   usa únicamente fotos de repisa.
6. `"¿Tienes más fotos?"` tras haber enviado las únicas dos de Mesa Auxiliar:
   no reenvía; responde que son las disponibles.
7. `"¿Tienes una foto del cajón por dentro?"` sin medio etiquetado para ese
   detalle: escala a Lili y no envía sustitutos.
8. Primer saludo desde referral/formulario de Mesa Auxiliar: mantiene las dos
   fotos correctas.
9. Conversaciones paralelas de dos leads con productos distintos: el estado de
   producto no se cruza.
10. Reinicio del proceso: el producto persistido continúa disponible.

## Identificación del incidente real

- Lead: `573104596410`
- Inicio: 27 de julio de 2026, 19:52
- Turnos relevantes: 28 de julio de 2026, 09:59-10:02
- Producto establecido conversacionalmente: Mesa Auxiliar
- Mensaje que precedió el envío: `"Si"`
- Respuesta visible: `"¡Claro! Aquí te muestro cómo queda 😊"`

## Verificación realizada

Después de instalar dependencias con scripts automáticos deshabilitados:

- Antes de implementar: `npm test`: **148 pruebas aprobadas, 0 fallidas**.
- Después de implementar: `npm test`: **157 pruebas aprobadas, 0 fallidas**.
- `node --check whatsapp_agent.js`: sintaxis válida.
- `npm audit` reportó 3 vulnerabilidades de severidad alta en dependencias. No
  se modificaron dependencias por estar fuera del alcance de esta sesión.

## Implementación realizada

1. El prompt prohíbe ofrecer fotos adicionales por iniciativa propia.
2. El backend valida la solicitud explícita del cliente y puede ignorar un
   `[FOTOS_EXTRA]` improcedente del modelo.
3. Una afirmación corta como `"Sí"` solo autoriza fotos si responde a una
   pregunta anterior que hablaba explícitamente de fotos.
4. El producto activo se resuelve con prioridad:
   mención actual → `leads.product` → historial reciente → respuesta actual.
5. El producto resuelto se persiste en la columna existente `leads.product`;
   no fue necesaria una migración.
6. `PRODUCTO_FOTOS_FALLBACK` quedó deshabilitado y un producto desconocido
   devuelve cero fotos.
7. Las solicitudes de detalles no catalogados se escalan de forma
   determinística a Lili, sin enviar sustitutos.
8. Se añadieron pruebas del incidente real, continuidad, cambio explícito de
   producto, ausencia de fallback, autorización y escalamiento por detalle.
9. Segundo incidente (`573207629644`): un mensaje genérico fue identificado
   correctamente como Mesa Auxiliar desde el anuncio, pero la respuesta solo
   decía `"compacta"`/`"clásica"`. El selector ahora recibe directamente el
   producto detectado desde referral/formulario, en vez de intentar deducirlo
   otra vez del saludo visible.

No se hizo commit, push ni despliegue.

## Segundo incidente real — producto correcto en texto, foto incorrecta

- Lead: `573207629644`
- Fecha: 28 de julio de 2026, 16:54
- Mensaje: `"¡Hola! Quiero más información"`
- Respuesta: opciones compacta 35×45cm y clásica 45×45cm de Mesa Auxiliar
- Riesgo confirmado en código: `bloqueReferral` sí informaba a Claude del
  producto, pero ese producto no se entregaba al selector de fotos.
- Corrección: `productoContextoOrigen` lleva la detección confiable del
  referral/formulario a `resolverProductoParaFotos()` y se persiste en
  `leads.product`.
- Prueba añadida con el texto exacto del caso.
