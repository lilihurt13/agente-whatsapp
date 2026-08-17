# Pendientes — no urgentes, revisar en sesión futura

## Cerrado (30 jul 2026) — el "formulario" nunca fue un Instant Form real, campaña nueva publicada

**Resuelto, y desde entonces la campaña ya corrió completa y terminó el 15 de agosto** (ver
`docs/OLIVIA_DOCUMENTO_MAESTRO.md` sección 6.3 para el detalle completo de causa raíz y fix, y
la revisión de métricas finales del 17 de agosto más abajo/en el maestro).

Resumen: nunca hubo un Instant Form de Meta (era un mensaje de bienvenida de WhatsApp con
preguntas en texto), y además la página no estaba suscrita al webhook `leadgen`. Se crearon 3
Instant Forms reales (uno por producto) y se activó la suscripción de la página. Campaña nueva
`HPL | Leads Formulario | Muebles | Agosto 2026` publicada el 30 jul, en prueba hasta el 15 de
agosto de 2026 (ya cerrada — ver revisión de resultados del 17 ago).

Las 2 verificaciones que habían quedado abiertas (prueba real desde teléfono externo, respaldo de
Google Sheets para Mesa Auxiliar/Repisa) quedaron sin resolver directamente, pero el problema de
fondo (lectura de leads por Olivia) se diagnosticó y corrigió por otra vía — ver el bloque de
Etapa 0/1 del 2-3 ago en el documento maestro, sección 6.3.

---

## Cerrado — Bug producto formulario: usar form_name como fallback (11 ago 2026)

**Cerrado (11 ago 2026).** `detectarProductoFormulario()` solo buscaba palabras
clave en los valores del `field_data`. El formulario de Mesa Auxiliar tiene
respuestas como `necesito_ayuda_para_elegir` y `más_adelante` — ninguna
contiene "mesa" ni "auxiliar", así que la función devolvía NULL aunque el
formulario fuera claramente de Mesa Auxiliar.

**Implementado:**
- Graph API fetch del leadgen ahora pide `fields: 'field_data,form'` para
  obtener el nombre del formulario (ej. `"Mesa Auxiliar"`).
- Nueva columna `form_name TEXT` en `lead_form_submissions` (ALTER TABLE IF
  NOT EXISTS al arranque) — se puebla junto con `field_data`.
- `detectarProductoFormulario(fieldData, formName)` acepta un segundo
  argumento opcional. Si el análisis de `field_data` no encuentra producto,
  busca en `formName` como último recurso.
- `formatearRespuestasFormulario()` y el cálculo de `productoFormularioParaFotos`
  pasan `formularioVinculado.form_name` al nuevo argumento.
- 248/248 tests en verde (sin tests nuevos — la función pura ya estaba cubierta).

**Nota:** este fix aplica a formularios NUEVOS. Carolina Salazar (573007863757)
ya tiene su `form_name = null` en la fila existente — para corregirla en
producción actualizar manualmente con el nombre real del formulario.

## Cerrado — 5ª opción de intención de compra "Más adelante" (11 ago 2026)

**Cerrado (11 ago 2026).** El formulario de Lead Ads tiene una 5ª opción en
el campo `¿cuándo_te_gustaría_comprarla?` con el valor `"Más adelante"` que
`detectarIntencionCompraFormulario()` no reconocía y dejaba caer al
comportamiento por defecto (cadencia de 3-24h, igual que
`en_los_próximos_15_días`).

**Implementado:**
- `'más_adelante'` agregado a `NIVELES_INTENCION_COMPRA_VALIDOS`.
- La función normaliza espacios a guiones bajos antes de comparar (tanto
  `"Más adelante"` como `"más_adelante"` retornan `'más_adelante'`).
- Cuando `intencionCompraPersistida === 'más_adelante'`, el seguimiento se
  guarda con `estado: 'reactivacion_futura'` en vez de `'saludo_sin_respuesta'`.
  El cron de reactivación 12pm/7pm solo opera sobre `saludo_sin_respuesta`,
  así que estos leads quedan fuera de toda reactivación automática.
- `MAPA_LIFECYCLE_STAGE` mapea `reactivacion_futura → 'FUTURE_INTENT'`.
- El panel de control muestra estos leads bajo la etiqueta
  "📅 Dijeron 'más adelante' — sin seguimiento automático".
- 8 nuevos tests agregados a `test/cadencia-intencion-compra.test.js`
  (total: 248 tests, todos en verde).

**Reactivación:** solo manual (Lili escribe directamente) o por campaña
cuando se active una nueva.

## Historial del diagnóstico original — El formulario de Lead Ads no es obligatorio de facto

**Confirmado (23 jul 2026):** aunque las 3 preguntas de cada uno de los 3
formularios (Repisa, Mesa Auxiliar, Escritorio) están marcadas como
obligatorias *dentro* del formulario, el cliente puede evadirlo por
completo — en vez de tocar el botón "Cotizar" (que abre el formulario),
puede simplemente escribir texto libre directamente en el chat de
WhatsApp desde la pantalla del anuncio.

Esto reduce el efecto de filtro de leads curiosos que se buscaba con el
formulario: un lead que evade el formulario no deja las respuestas
estructuradas (ciudad, medida, momento de compra) que permiten calificar
mejor su intención de compra, y tampoco activa el flujo de personalización
de la Fase 1B (`obtenerFormularioVinculadoReciente`) — aunque si el
`referral_data` del anuncio sigue disponible, el Ajuste 1 sí cubre parte
de este caso (ver `whatsapp_agent.js`, `detectarProductoDesdeReferral`).

**No implementado — pendiente de decisión futura.** Cuando se retome,
evaluar:

- Si el formato de campaña actual en Meta Ads Manager (Click-to-WhatsApp
  con Instant Form adjunto) permite configurar que el formulario sea el
  *único* punto de entrada — es decir, que el clic en el anuncio abra
  directamente el formulario sin la opción de escribir texto libre antes.
- Si Meta no lo permite a nivel de configuración de campaña, evaluar si
  vale la pena un mensaje de bienvenida en el chat que invite
  explícitamente a completar el formulario si no lo hizo, en vez de asumir
  que ya lo evadió.

No bloquea nada del sistema actual — todos los flujos (con formulario, con
solo referral, o sin ninguno de los dos) ya funcionan de forma segura y
sin romperse.

**🔄 ACTUALIZACIÓN (30 jul 2026) — hallazgo nuevo, más grave que el de
arriba: el webhook de `leadgen` nunca ha llegado, ni una sola vez.**
Lili reportó que un cliente sí llenó el formulario de Mesa Auxiliar el 26
jul (visible como 1 resultado "Leads" en Meta Ads Manager para esa
campaña), pero Olivia nunca se enteró. Se verificó directamente la tabla
`lead_form_submissions` en la base de datos de producción (Railway →
Postgres → Data): **está completamente vacía, 0 filas.**

Esto descarta la hipótesis de que el problema sea de nombre de campo de
teléfono no reconocido en `CAMPOS_TELEFONO_FORMULARIO` — si el evento
hubiera llegado, `manejarEventoLeadgen()` ya habría insertado una fila
(aunque fuera con `estado_vinculacion = 'FALLIDO'`). Que no exista
ninguna fila significa que el evento webhook **nunca llegó al servidor**,
lo cual coincide exactamente con el punto A ya anotado junto a
`manejarEventoLeadgen()` en `whatsapp_agent.js`: falta confirmar que la
PÁGINA específica de Facebook (`page_id = 111790491414012`, "Hecho por
Lili") esté suscrita a la app para el campo `leadgen` — esto es
independiente de la suscripción a nivel de app ya confirmada el 22 jul.

Señal adicional (no concluyente): al consultar esa página vía la API de
Meta Ads, devuelve `page_name: "(unknown)"` y `leadgen_tos_accepted:
false`, lo que sugiere permisos incompletos sobre la página desde la
integración usada para diagnosticar — consistente con, aunque no prueba
por sí solo, que falte esa suscripción.

**Pendiente de verificar/activar (requiere acceso de Lili a Graph API
Explorer desde una computadora, con permisos de administradora de la
página):**

1. `GET /111790491414012/subscribed_apps` con un Page Access Token
   (permisos `pages_manage_metadata` + `leads_retrieval`) — confirmar si
   el campo `leadgen` ya aparece suscrito para esta página.
2. Si no aparece: `POST /111790491414012/subscribed_apps?subscribed_fields=leadgen`
   con ese mismo token para activarlo.
3. Confirmar también que el permiso `leads_retrieval` esté concedido al
   token que usa el servidor (`META_API_TOKEN`) — ver App Dashboard →
   Revisión de la app → Permisos y funciones. Si este permiso falta en
   vez del punto 1-2, el síntoma sería distinto (el webhook sí llegaría y
   quedaría una fila con `estado_vinculacion = 'FALLIDO'` por error de
   Graph API) — no es lo que se está viendo ahora, pero conviene
   revisarlo de una vez ya que está en el mismo flujo.

Una vez activada la suscripción, generar un lead de prueba real (llenar
uno de los 3 formularios) y volver a revisar `lead_form_submissions` para
confirmar que la fila aparece.

## Fase C futura — descuento por volumen en el cotizador de repisas

**Decisión de negocio (26 jul 2026, durante la integración del cotizador
v2):** `resolverPrecioRepisa()` solo resuelve el precio de **una unidad**
— no multiplica por `cantidad` ni aplica ninguna regla de volumen. Ya
existen reglas de descuento por volumen aprobadas por Lili (2-3 unidades
5-10%, 4-6 unidades 10-20%, etc.), pero **no están implementadas todavía**.

Por eso, mientras no exista esa lógica: **`cantidad > 1` siempre escala a
Lili** — nunca se calcula ni se ofrece un precio cerrado automático para
pedidos de más de una repisa (mismo criterio que la modalidad `recogida`).
Esto ya está reflejado en `extraerTagCotizarRepisa()`
(`elegibleParaCalculoAutomatico: cantidad === 1`) — ver
`docs/COTIZADOR_V2_PLAN.md`.

**Pendiente para una sesión futura:** implementar `calcularDescuentoPorVolumen(cantidad, precioUnitario)`
con su propia tabla de reglas (a definir con Lili: los rangos exactos y
si el descuento aplica sobre `comercial_instalado`/`comercial_enviado` o
sobre el `precioFinalSugerido` ya resuelto), y solo entonces permitir que
`cantidad > 1` participe en el cálculo automático del tag
`[COTIZAR_REPISA:...]`.

## El bloque de reintento de Claude nunca envía fotos

**Encontrado (26 jul 2026, durante el diagnóstico de "fotos por
producto"):** dentro de `procesarMensaje()`, si la primera llamada a
Claude falla y se dispara el bloque de reintento, ese camino hace
`agregarMensaje()`, revisa `necesitaEscalar` y llama a `enviarMensaje()`
— pero **nunca** llama a `enviarFotosSaludo()` ni a `enviarFotosExtra()`.
Es decir: si el reintento se activa justo en el primer mensaje de un
cliente nuevo, o justo cuando pide fotos explícitamente, el cliente se
queda sin fotos aunque el resto de la respuesta le llegue bien.

**No se toca en esta tarea** (fuera de alcance de "fotos por producto",
por instrucción explícita de Lili) — solo queda documentado aquí para
una sesión futura. Cuando se retome: replicar en el bloque de reintento
la misma lógica de detección de `[FOTOS_EXTRA]`/primer-mensaje y envío
de fotos que ya tiene el camino principal (usando
`detectarProductoParaFotos()` una vez esté conectado — ver Fase 3 de
`feature/fotos-por-producto`).

## Familia de repisas entamboradas — pendiente

Repisas con espesor 4.5cm (material 15mm) o 5.4cm (material 18mm),
instalación con listones en vez de soportes invisibles — familia de
producto distinta a la actual, no implementada todavía.

Cuando un cliente pida un espesor EXACTO de 4cm o 5cm (no 4.5 ni
5.4cm), Olivia debe escalar siempre — cambia el proceso real de
construcción, no es solo un tema de precio. Esta regla de escalamiento
tampoco está implementada todavía (decisión de Lili, 27 jul 2026:
fuera de alcance mientras se ajusta el cotizador v2 para el caso de
profundidad ≠ 15cm).

## Cerrado — la tarjeta de "Anuncio de Facebook" en WhatsApp puede mostrar otro anuncio (no es un bug nuestro)

**Cerrado (27 jul 2026).** Lili reportó un caso con evidencia visual: el
lead `573174689618` (conversación en la app de WhatsApp Business) mostraba
la tarjeta de "Anuncio de Facebook" con el texto de un anuncio de
Escritorio Flotante, pero Olivia respondió sobre Mesa Auxiliar.

**Investigado y descartado como bug del código.** Se consultó
`leads.referral_data` real en la base de datos para ese número: el
`headline`/`body` guardado ahí corresponde inequívocamente a un anuncio de
**Mesa Auxiliar** ("Mesa auxiliar desde $390.000", con las opciones
Compacta/Clásica). Es decir, `referral_data` (lo que Meta le manda a
nuestro webhook) y la respuesta de Olivia coincidían correctamente. La
tarjeta visual que muestra la app de WhatsApp Business en el celular es
una pieza de UI de Meta, independiente del payload de `referral` que
recibe el webhook — puede mostrar información de otro anuncio (ej. por
caché, por un anuncio distinto que el cliente vio antes en el mismo hilo,
o por comportamiento propio de Meta) sin que eso refleje lo que realmente
llegó a `whatsapp_agent.js`.

**Si vuelve a surgir esta confusión:** confirmar primero con
`scripts/ver_referral_lead.js` (o la consulta SQL directa a
`leads.referral_data`) qué anuncio quedó realmente registrado para ese
lead, antes de asumir que Olivia detectó mal el producto. Si
`referral_data` coincide con la respuesta de Olivia, el problema es de
visualización en la app de Meta, no de nuestro código, y no hay nada que
corregir en `whatsapp_agent.js`.

**Nota aparte:** el reporte de este caso sí sirvió para encontrar un
riesgo real y distinto en el código — `CLAVES_PRODUCTO_FORMULARIO` tenía
palabras genéricas (`'versión'`, `'compacta'`, `'clásica'`) en las claves
de Mesa Auxiliar que podían cruzarse con el copy de otros anuncios. Ese
fix sí era necesario y quedó hecho — ver la entrada del 27 jul en el
historial de Fase 1A/Ajustes.

## Cerrado — Mesa Auxiliar ofrecía "patas desmontables para armar" incluso en Medellín

**Cerrado (29 jul 2026), commit `4bd4644` en `main`, desplegado y
confirmado por logs de Railway (arranque limpio).** Confirmado con un log
real: Olivia le dijo a un cliente de Medellín que la mesa auxiliar llega
con "patas desmontables para armar", cuando la regla de negocio real es
que en Medellín la mesa **siempre** se entrega completamente armada — el
desmontaje de patas es exclusivo de envíos a otras ciudades (facilita
empaque/transporte).

**Causa raíz:** el catálogo de `getSystemPrompt()` (sección "5. MESA
AUXILIAR") tenía `- Patas desmontables` como un hecho plano del producto,
sin condicionar a la ciudad del cliente. La regla maestra de
instalación/envío (resumen por mueble) tampoco distinguía Medellín de
otras ciudades para este punto.

**Fix:** ambos lugares del prompt quedaron condicionados explícitamente:
Medellín → "se entrega COMPLETAMENTE ARMADA... NUNCA digas que tiene
patas desmontables ni que el cliente arma algo"; otra ciudad → "se envía
con patas desmontables (fácil ensamble con tornillos)". Sin capa de
código determinística que filtre la respuesta de Claude después del
hecho (a diferencia del filtro de envío gratis, ver más abajo) — depende
por completo de que el prompt deje la regla sin ambigüedad. 6 pruebas
nuevas en `test/fix4-mesa-auxiliar-ensamble.test.js` verifican el
contenido del prompt (no simulan la respuesta real de Claude, ya que un
stub de `llamarClaude` solo devuelve lo que el propio test le programe).

**Pendiente de confirmar en una conversación real:** el próximo cliente
de Medellín que pregunte por el ensamble/instalación de la mesa auxiliar
— confirmar que Olivia ya no menciona tornillos ni desmontaje.

## Cerrado — mensajes de WhatsApp con `message.type` no contemplado se perdían en silencio total

**Cerrado (29 jul 2026), commit `7a67897` en `main`, desplegado y
confirmado por logs de Railway (arranque limpio).** Lead real (María)
cuyo mensaje entrante nunca produjo ni "🆕 Lead creado" ni "Mensaje
de..." en los logs, sin ningún error visible. El webhook sí recibía el
mensaje (`📩 Webhook recibido` con `message_id` presente).

**Causa raíz:** el webhook (`POST /webhook`) solo tenía ramas `if` para
`message.type` igual a `text`, `image`, `video`, `audio` o `document` —
sin ningún `else` de respaldo. Un tipo no contemplado (`interactive`,
`button`, `contacts`, `location`, `sticker`, `reaction`, `order`,
`system`, `unsupported`, etc.), o un `from` que no pasara
`esNumeroValido()`, caía entre todas las condiciones sin loguear nada y
sin lanzar ninguna excepción — el `catch` general del webhook nunca se
activaba porque no había error que capturar. No fue una excepción sin
capturar; fue un hueco de lógica sin rama de respaldo.

**Fix:** se extrajo `tipoDeMensajeEsManejado(message, esSaliente)` como
función pura que centraliza la decisión. Cuando ningún caso aplica, ahora
se loguea explícitamente (`❌ Mensaje entrante NO MANEJADO...`, con
`type`/`from`/`message_id`, nunca el contenido) y se notifica a Lili en
el momento vía `notificarLili()`, igual que ya se hacía con mensajes
fallidos de Meta. 6 pruebas nuevas en `test/webhook-tipo-mensaje.test.js`.

**Pendiente:** confirmar en un lead real futuro que, si vuelve a llegar
un `message.type` no manejado, el aviso a Lili y el log `❌` sí aparecen
(esta vez no se pudo reproducir el payload exacto del caso de María para
confirmar cuál tipo específico lo causó — solo se cerró el hueco general).

## Bloqueo externo — permiso `leads_retrieval` sin Advanced Access (Meta App Review)

**Detectado (2 ago 2026), durante la auditoría de leads de formulario mal
atendidos.** `manejarEventoLeadgen()` recibe correctamente el evento
`leadgen` (webhook, ID de formulario, de anuncio, de página — confirmado
en logs reales), pero la llamada a Graph API que trae las respuestas del
formulario (`GET /{leadgen_id}?fields=field_data`, `whatsapp_agent.js`
~línea 2843) falla siempre con `400 GraphMethodException code:100
subcode:33`. **8 de 8 eventos leadgen recibidos desde el 31 de julio
tienen `estado_vinculacion = 'FALLIDO'` en `lead_form_submissions`, sin
ninguna excepción.**

**Causa:** el token usado (`META_API_TOKEN`) no tiene el permiso
`leads_retrieval` en Advanced Access — sigue en Standard Access, que solo
sirve para formularios/Páginas de prueba, no para leads reales de
clientes. Esto es 100% independiente del código: no hay ningún fix en
`whatsapp_agent.js` que lo resuelva. El manejo de error ya está bien
hecho (registra `FALLIDO`, loguea el error, no rompe nada más) — solo
falta que Meta apruebe el permiso.

**No bloquea el resto del trabajo.** Los bugs de código encontrados en la
misma auditoría (fallo silencioso del webhook, condición de carrera,
seguimiento genérico, formulario duplicado, alucinación de contenido no
visto) son independientes de si `field_data` del formulario llega o no —
se corrigen igual.

**Acción en curso (Lili, iniciada 2 ago 2026):** trámite de Meta App
Review para pasar `leads_retrieval` de Standard a Advanced Access. Pasos:

1. Completar Meta Business Verification en el Business Manager dueño de
   la app (si no está hecha ya — suele ser el paso que más tarda).
2. App Dashboard → App Review → Permisos y funciones → `leads_retrieval`
   → Solicitar Advanced Access. Junto con `leads_retrieval`, la doc
   oficial de Meta pide también `pages_manage_ads`, `pages_read_engagement`,
   `pages_show_list`, y `pages_manage_metadata` (por ir vía webhook, que
   ya está configurado).
3. Preparar el material de la solicitud (lo que más causa rechazo si
   falta):
   - Screencast mostrando un lead REAL de punta a punta: cliente completa
     el formulario → llega el webhook → aparece en el sistema (no sirve
     una pantalla de configuración vacía).
   - Texto de caso de uso: qué campos del formulario se acceden, dónde se
     guardan (`lead_form_submissions.field_data`), quién puede verlos.
   - Política de privacidad que cubra explícitamente manejo/retención de
     datos de leads.
4. Enviar a revisión. Tiempo de aprobación no confirmado — depende de
   Meta, revisar el estado directamente en el dashboard.

**Mientras se aprueba:** se puede usar la Lead Ads Testing Tool del
dashboard (formularios de prueba, cubiertos por Standard Access) para
dejar todo el pipeline (webhook → Graph API → `lead_form_submissions`)
probado de punta a punta, y de paso generar el material del screencast
que Meta pide.

## URGENTE — Rediseñar `/control` tras el incidente de `cmd=todo` (2 ago 2026)

**Confirmado (2 ago 2026):** `cmd=todo` en `/control` mezcla "quitar pausa
global" con `quitarTodosPausados()` (`DELETE FROM pausados` sin condición),
borrando de un golpe todos los números pausados manualmente — no solo la
pausa global. Vació ~126 filas; solo se pudieron reconstruir 10 con
confianza razonable (cruzando logs de escalamiento desde el arranque del
30 jul, `leads.owner='LILI'`, y `notas`) y restaurar por `INSERT` aprobado
por Lili. El resto probablemente sigue perdido — ver
`docs/OLIVIA_DOCUMENTO_MAESTRO.md` sección 6.4 para el detalle completo.

**Causa raíz que falta corregir (no solo documentar):**
1. `cmd=todo` debería separar "pausadoTodo=false" de "reactivar
   individuales" — o al menos requerir una confirmación explícita distinta
   para lo segundo, ya que son operaciones de impacto muy distinto.
2. Ningún comando de `/control` deja rastro en `lead_events` ni en logs de
   aplicación — son completamente silenciosos. Cualquier acción de
   `/control` (`pausa`, `reanudar`, `pausatodo`, `todo`, `cerrado_venta`,
   `cerrado_perdido`) debería registrar un evento (actor, número, comando,
   timestamp) para que un incidente futuro sí se pueda reconstruir sin
   depender de inferencias indirectas por logs.
3. Evaluar si `pausados` necesita ON DELETE más seguro (soft-delete con
   timestamp en vez de DELETE físico) para que un vaciado accidental sea
   reversible sin reconstrucción manual.

**Mitigación desplegada mientras se corrige lo anterior:** feature flag
`REACTIVACION_12_19_ENABLED` (default apagado) apaga el cron de 12pm/7pm
que le manda a cualquier lead pausado un mensaje automático de "repisa" —
ver sección 6.4 del documento maestro. El cron horario de seguimiento y
las respuestas en tiempo real de Olivia no se tocaron.

**No cerrar este pendiente hasta:** (a) decidir y corregir el diseño de
`cmd=todo`/`/control`, (b) confirmar con Lili si los ~116 números
restantes se dan por perdidos o si aparece una vía de recuperación
(point-in-time recovery de Postgres en Railway, o memoria de Lili).

**Cuándo se puede cerrar este pendiente:** cuando `estado_vinculacion`
empiece a salir `VINCULADO` (o el estado de éxito equivalente) en
`lead_form_submissions` para un lead real nuevo — eso confirma que
Advanced Access ya quedó activo.
