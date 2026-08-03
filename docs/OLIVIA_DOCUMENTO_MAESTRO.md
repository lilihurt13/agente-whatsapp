# DOCUMENTO MAESTRO — Proyecto Olivia (Hecho por Lili)

**Última actualización:** 3 de agosto de 2026
**Propósito de este documento:** ser el punto de partida para CUALQUIER asistente de IA nuevo (Claude Code, ChatGPT Codex, o cualquier otro) que retome este proyecto. Si estás retomando el trabajo en una sesión nueva o con una herramienta distinta, pega este documento completo al inicio antes de pedir cualquier cambio. Súbelo también a `docs/OLIVIA_DOCUMENTO_MAESTRO.md` en el repositorio para que quede accesible desde GitHub, no solo en un chat de Claude.

---

## ⚠️ REGLA FIJA — LECTURA OBLIGATORIA PARA CUALQUIER IA QUE TRABAJE EN ESTE PROYECTO

**Este documento debe actualizarse SIEMPRE que se haga cualquier cambio al proyecto — no solo cambios grandes.** Esto aplica sin importar qué asistente de IA esté ejecutando el trabajo (Claude Code, ChatGPT, cualquier otro).

Reglas concretas:

1. **Al final de CADA sesión de trabajo** (sin importar si el cambio fue pequeño, mediano o grande), la IA que ejecutó el trabajo debe actualizar este documento con lo que se hizo, sin que Lili tenga que pedirlo explícitamente cada vez — es parte normal del cierre de cualquier tarea, igual que correr las pruebas o pedir autorización antes de un push.
2. **No dejar nada "a medias" sin documentar** — si algo quedó pendiente, en construcción, o con una decisión de negocio tomada pero sin implementar todavía, debe quedar anotado explícitamente en la sección correspondiente (Pendientes, En Construcción, o Bugs Abiertos) para que la siguiente sesión (con la misma IA o una distinta) sepa exactamente en qué punto se quedó, sin necesitar que Lili lo recuerde de memoria.
3. **Este documento vive en el repositorio** (`docs/OLIVIA_DOCUMENTO_MAESTRO.md`), no solo en un chat — cualquier IA con acceso al repo debe leerlo antes de empezar a trabajar, y actualizarlo (commit normal, sin necesitar autorización especial ya que es solo documentación) antes de cerrar la sesión.
4. **Si Lili es quien actualiza el documento manualmente** (por ejemplo, copiando un resumen de un chat de Claude.ai a la versión en GitHub), la IA que retome el trabajo después debe confirmar que está viendo la versión más reciente antes de asumir que algo ya está resuelto.

El objetivo es que, sin importar qué herramienta de IA se use en el futuro, o si Lili tiene que cambiar de asistente por cualquier razón (créditos agotados, preferencia, disponibilidad), nunca se pierda contexto ni se corra el riesgo de dañar el código por desconocer una decisión ya tomada.

---

## 1. QUÉ ES OLIVIA Y QUÉ ES HECHO POR LILI

**Hecho por Lili** es una marca de muebles artesanales en roble natural macizo, con base en Medellín, Colombia, fundada por Lili Hurtado. Todo se fabrica bajo pedido, sin tienda física.

**Olivia** es la agente de IA que atiende WhatsApp por Lili. Es un servidor Node.js que corre 24/7 en Railway, usa Claude Haiku 4.5, y sigue reglas de negocio muy específicas en un "system prompt" (`getSystemPrompt()`). Se presenta como *"parte del equipo de Hecho por Lili"* — nunca como Lili misma.

---

## 2. ARQUITECTURA TÉCNICA

### 2.1 Stack
- **Código:** un solo archivo `whatsapp_agent.js` (~3300+ líneas), Node.js/Express
- **Base de datos:** PostgreSQL en Railway
- **IA conversacional:** Claude Haiku 4.5 vía API de Anthropic
- **Mensajería:** WhatsApp Business Cloud API (Meta)
- **Notificaciones internas:** Telegram
- **Imágenes:** Cloudinary
- **Repositorio:** GitHub `lilihurt13/agente-whatsapp`, rama `main`
- **Hosting:** Railway — **auto-deploy SOLO desde push a `main`**, ninguna otra rama

### 2.2 Flujo de trabajo para hacer cambios
0. Toda herramienta debe leer primero `AGENTS.md`. Claude Code además recibe
   la misma entrada mediante `CLAUDE.md`. Ambos archivos obligan a leer este
   documento maestro y `docs/PENDIENTES.md` antes de trabajar.
1. Lili abre Claude Code en su computador (`~/Documents/agente-whatsapp`), ejecuta `claude`
2. Trabajo por fases: rama nueva → diagnóstico → plan aprobado por Lili (vía Claude.ai como supervisor) → código → pruebas → resumen → commit (solo en rama) → **push a main solo con autorización explícita de Lili**
3. Railway redespliega automáticamente al detectar push a `main`
4. **Regla de oro:** nunca commitear/pushear sin que Lili vea el resumen y las pruebas primero
5. GitHub ejecuta `.github/workflows/verificar-documentacion.yml` en cada pull
   request hacia `main` y en cada push directo a `main`. Si cambian código,
   configuración, datos, scripts o pruebas sin actualizar este documento, la
   comprobación falla y deja una alerta visible. En pull requests puede impedir
   la integración si se configura como comprobación obligatoria; en pushes
   directos alerta después del cambio.

### 2.3 Variables de entorno críticas (Railway → Variables, nunca en código)
`META_API_TOKEN`, `PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `ANTHROPIC_API_KEY`, `CONTROL_TOKEN`, `LILI_NUMERO`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`, `DATABASE_URL`/`DATABASE_PUBLIC_URL`, `COTIZADOR_REPISAS_V2_ENABLED` (feature flag, ver sección 5), `META_APP_ID` (opcional, default hardcodeado — App ID de Meta, público, no secreto), y **`PAGE_ACCESS_TOKEN`** (fallback manual de la Etapa 0 de Lead Ads, ver sección 6.3 — token de página de larga duración puesto a mano, expira ~2 de octubre de 2026).

**Railway NO tiene backups automáticos** — antes de cualquier migración de esquema se corre `scripts/backup_produccion.js` (exporta cada tabla a JSON).

---

## 3. BASE DE DATOS

### 3.1 Tablas legacy
`conversaciones` (recorte a 12 mensajes, lo que lee Claude), `pausados`, `seguimientos`, `notas`, `ajustes`.

### 3.2 Tablas del CRM (Fase 1A/1B, 22-24 julio)
- `leads` — entidad central por teléfono, incluye `referral_data` (JSONB del anuncio de origen)
- `messages` — historial COMPLETO, con `whatsapp_message_id` UNIQUE para idempotencia real
- `lead_events` — bitácora de 10 tipos de eventos
- `lead_form_submissions` — respuestas de formularios de Meta Lead Ads, vinculadas por teléfono (ventana 48h)

### 3.3 Tabla del cotizador (nueva, 26-27 julio)
- `precios_repisas` — 66 filas sembradas desde `data/precios_repisas_v2.csv`. Columnas: `prof_cm`, `largo_cm`, `costo_real_instalado`, `tecnico_instalado`, `comercial_instalado`, `costo_real_enviado`, `tecnico_enviado`, `comercial_enviado`, `envio_real_estimado`, `precio_minimo_aprobado`, `alerta`, `requiere_aprobacion_descuento`.

### 3.4 Panel visual hoy
Pestañas: 🔵 Atendiendo yo / 🟢 Olivia maneja / ✅ Ventas / ❌ Perdidos / ❄️ Fríos. Chat individual, notas, pausar/reactivar, buscador. **No muestra** visualmente datos del CRM ni del cotizador — pendiente.

---

## 4. REGLAS DE OLIVIA (`getSystemPrompt()`)
- Tono cálido, colombiano (nunca modismos mexicanos), sin asteriscos
- Regla de oro: SIEMPRE características antes que precio
- Nunca inventar precios — escalar cuando no hay certeza
- Escalamiento: `[ESCALAR]`, pausa el número, notifica por Telegram (dedup 5 min)
- 6 protecciones de LILI_NUMERO en el código
- Frases de escalamiento dejan claro que es Lili quien confirma, no Olivia

---

## 5. COTIZADOR DE REPISAS V2 — ESTADO ACTUAL (26-27 julio)

### 5.1 Qué existe y funciona
- Tabla `precios_repisas`, 66 combinaciones exactas (profundidades 10/15/20/25/30cm)
- Tag interno `[COTIZAR_REPISA:largo=X,prof=Y,cantidad=1,ciudad=Z,modalidad=W]` — Claude nunca calcula, solo detecta y emite el tag; el backend intercepta, calcula, y hace una **segunda llamada a Claude** con el precio resuelto
- **Feature flag `COTIZADOR_REPISAS_V2_ENABLED`** — actualmente **activo en producción** desde el 27 de julio
- Modalidades: `instalado_medellin` (default), `envio_nacional` (sin instalación, transporte/buffer retenido, envío al cliente sigue viniendo de la tabla de envíos existente), `recogida` (siempre escala)
- `cantidad > 1` siempre escala (sin lógica de volumen implementada)
- Doble capa de seguridad: parser filtra por cantidad, `resolverPrecioRepisa()` filtra por modalidad independientemente

### 5.2 Bug de solapamiento — YA CORREGIDO (27 julio)
Al activar el flag, Olivia no preguntaba profundidad para medidas fuera de 15cm — el catálogo v1 tiene 5 secciones que tratan 15cm como constante fija, compitiendo con el bloque nuevo. **Fix:** el bloque nuevo se auto-limita explícitamente a profundidad ≠ 15cm en vez de declarar "prioridad" — sin solapamiento.

### 5.3 EN CONSTRUCCIÓN — cálculo por fórmula para medidas no exactas

**Decisión de Lili (27 julio):** Olivia debe calcular con fórmula completa cualquier medida en rangos seguros, no solo las 66 exactas.

**Fórmula aprobada** (validada con 110×25=$380.000, 175×20=$460.000, 95×30=$420.000):
- Área = (largo+1) × (profundidad+1) × 2
- Material = área × $20,1559/cm²
- Barniz/Mano de obra: 3 categorías (pequeña ≤50cm y ≤15cm prof / mediana ≤120cm y ≤25cm / grande >120cm O >25cm prof)
- Soportes: 3 categorías por profundidad (12cm/$5.000 prof10; 18cm/$7.000 prof15-20; 25cm/$10.000 prof25-30), cantidad por largo (≤80=2, 90-140=3, 150-200=4)
- Fijos: instalación $30.000 + transporte $30.000 + consumibles $8.000
- Valor técnico = costo real / 0.65
- **Precio comercial = `Math.ceil(valorTecnico / 10000) * 10000`**

**Rangos seguros (fuera de esto, SIEMPRE escala):**
- Solo sandwichadas 3.6cm (nunca entamboradas/espesor 4.5-5.4cm)
- Profundidad exacta en {10,15,20,25,30}cm — intermedias NO interpolan, escalan
- Largo 20-200cm
- Profundidad >30cm nunca calcula (cambia sistema de instalación)
- Sin interpolación entre filas vecinas

**Estado al cierre del 27 julio:** especificación completa aprobada (por Lili y por el diseñador original de costos vía ChatGPT). Claude Code escribiendo `calcularPrecioRepisaDesdeFormula()` + `resolverPrecioRepisa()` actualizado + guardas + pruebas de casos límite. **NO confirmado que las pruebas ya pasen** — pendiente revisar antes de commit.

---

## 6. BUGS ABIERTOS SIN RESOLVER (27 julio)

### 6.1 Fotos enviadas sin que el cliente las pida — CORREGIDO EN RAMA, PENDIENTE DE DESPLIEGUE (28 julio)
Historial real identificado: lead `573104596410`. Después de establecer Mesa Auxiliar, el cliente respondió `"Sala"`. Olivia ofreció fotos por iniciativa propia (`"¿Te gustaría verla en fotos...?"`), el cliente contestó `"Si"` y entonces Olivia disparó `[FOTOS_EXTRA]` con fotos equivocadas de Repisa.

El diagnóstico en `feature/fix-fotos-contexto-conversacion` confirmó dos causas independientes:
- el backend acepta `[FOTOS_EXTRA]` emitido por Claude sin exigir que el cliente haya pedido fotos explícitamente;
- para cada envío recalcula el producto solo con `[texto_del_turno, respuesta_Claude]`, sin historial ni producto persistido, y si no encuentra el producto fuerza `Repisa Flotante` como fallback.

Precisión tras recibir el historial: las fotos no se enviaron directamente al
decir `"Sala"`; Olivia indujo la solicitud ofreciéndolas sin necesidad. El
fallo de contexto ocurrió en el turno siguiente, porque `"Si"` y la respuesta
breve no nombraban Mesa Auxiliar.

También se confirmó que Mesa Auxiliar solo tiene las dos fotos del saludo y `seleccionarFotosExtra()` actualmente las repite. Regla de negocio: no repetirlas automáticamente ni sustituir con otro producto; ante un detalle específico inexistente, escalar.

Implementación terminada en `feature/fix-fotos-contexto-conversacion`:
- el prompt prohíbe que Olivia ofrezca fotos adicionales por iniciativa propia;
- el backend exige solicitud explícita y puede ignorar `[FOTOS_EXTRA]` improcedente;
- respuestas como `"Sí"` solo cuentan si responden a una pregunta anterior sobre fotos;
- el producto activo se conserva en la columna existente `leads.product` y usa historial como respaldo;
- se eliminó el fallback a Repisa Flotante: producto ambiguo significa no enviar;
- solicitudes de detalles no disponibles escalan a Lili sin imágenes sustitutas.
- los saludos genéricos identificados por anuncio/formulario pasan ese producto
  directamente al selector de fotos; no dependen de que la respuesta visible
  repita el nombre del mueble. Esto cubre el segundo caso real
  `573207629644` (texto correcto de Mesa Auxiliar, foto de otro producto).

Verificación: **159 pruebas aprobadas, 0 fallidas**, sintaxis válida. Aún no se ha hecho commit, push a `main` ni despliegue. Informe completo: `docs/DIAGNOSTICO_FOTOS_CONTEXTO_CONVERSACION.md`.

### 6.2 Catálogo de Mesa Auxiliar mezclado + envío nacional sin costo definido — EN PRODUCCIÓN desde 2026-07-29

Diagnóstico confirmado con `referral_data` real (ver docs/PENDIENTES.md, caso cerrado del 27 julio): el anuncio real de Mesa Auxiliar ofrece dos variantes ("Mesa auxiliar desde $390.000", Compacta/Clásica), pero el catálogo en `getSystemPrompt()` tenía una sola ficha mezclada (35×45×50cm siempre a $420.000). Además, la regla de envío nacional para Mesa Auxiliar no dejaba explícito que el costo de envío NO está incluido en el precio del mueble — riesgo real de que Olivia prometiera envío gratis a un cliente de otra ciudad.

Rama `feature/fix-catalogo-mesa-envio`, tres partes:

1. **Catálogo separado en dos fichas:** COMPACTA (35×45×50cm, $390.000) y CLÁSICA (45×45×50cm, $420.000), reemplazando la ficha única.
2. **Regla de envío explícita:** tanto en la ficha del catálogo como en el bloque "Otra ciudad" del prompt — el envío nacional existe pero su costo NO está incluido, nunca se inventa/asume, siempre se escala a Lili para el valor exacto.
3. **Filtro determinístico de respaldo (`respuestaPrometeEnvioGratisSinAprobar()`):** corre sobre la respuesta REAL de Claude (no solo confía en que siga la instrucción del prompt) antes de enviarla al cliente. Busca, oración por oración, una palabra de la familia "envío/despacho" junto con una palabra de "gratuidad/inclusión" (gratis, sin costo, no cobro, por nuestra cuenta, incluye/incluido, etc.) — nunca frases exactas completas, para cubrir variantes. Si detecta la combinación y Claude no escaló por su cuenta, sustituye la respuesta por un mensaje de escalamiento **fijo** (nunca genera el reemplazo con una segunda llamada a Claude, para no arriesgar que esa segunda llamada también alucine).
   - **Alcance por lista blanca, no por condición ad-hoc:** `PRODUCTOS_CON_ENVIO_GRATIS_APROBADO` (vacía hoy — se llena solo si Lili aprueba un envío gratis real) y `PRODUCTOS_CON_MANEJO_PROPIO_DE_ENVIO` (hoy solo `'Repisa Flotante'`, porque ese producto ya resuelve su envío por tabla fija o por fórmula del cotizador v2, con sus propias pruebas — ahí "envío incluido" es una frase legítima que ya está en producción, y bloquearla habría sido un falso positivo).
   - Se conecta en `procesarMensaje()` en el mismo punto donde ya vive el filtro de `solicitudFotoDetalleEspecifico()` (antes de `agregarMensaje`), con el mismo criterio: solo actúa si Claude no emitió `[ESCALAR]` por su cuenta.

Pruebas: `test/fix-catalogo-mesa-envio.test.js` (7, texto del prompt) + `test/fix3-filtro-envio-gratis.test.js` (18, función del filtro + integración end-to-end) — **184/184 pruebas totales pasan, 0 fallos**.

**Mergeado a `main` (commit `b126f5f`, merge `40dd7e3`) y pusheado a `origin/main` el 2026-07-29. Deploy en Railway confirmado por Lili como exitoso.**

### 6.3 El formulario de Lead Ads parece no aportar nada — ETAPA 0 COMPLETADA (3 ago 2026)
Sospecha original de Lili: Olivia no está usando datos de formulario (ciudad, versión) en conversaciones reales. **Causa raíz confirmada (2 ago 2026):** `manejarEventoLeadgen()` usaba `META_API_TOKEN` (un User Token) para leer `{leadgen_id}?fields=field_data`, pero ese endpoint necesita un **Page Access Token** con permiso `leads_retrieval` — el User Token nunca lo tuvo, sin importar el estado de Standard/Advanced Access.

**Fix (Etapa 0, 3 ago 2026):**
- `obtenerPageAccessToken()` deriva un Page Access Token al arranque llamando a `me/accounts` con `META_API_TOKEN`, y lo extiende a larga duración vía `fb_exchange_token` (necesita `META_APP_SECRET` + `META_APP_ID`).
- **En producción, esa derivación automática falla** (`me/accounts` devuelve 0 páginas — el `META_API_TOKEN` actual no tiene permiso para listar páginas; pendiente diagnosticar por qué, ver sección 7). No bloquea nada: el fallo se loguea y el resto del servidor sigue funcionando igual (WhatsApp intacto).
- **Fallback activo:** variable `PAGE_ACCESS_TOKEN` puesta a mano en Railway con un Page Access Token de larga duración ya generado (60 días, **expira aproximadamente el 2 de octubre de 2026** — hay que renovarlo antes de esa fecha o volverá a fallar en silencio). Si la derivación automática falla, `obtenerPageAccessToken()` usa este valor directamente.
- **Verificado con lead real en producción (3 ago 2026):** `GET /{leadgen_id}` con el `pageAccessToken` resultante devolvió correctamente `field_data` y `created_time` del leadgen_id de Omaira Quintero (`2841838099548700`) — confirma que la Graph API de Lead Ads ya funciona de punta a punta con datos reales.

**Pendiente (Etapa 1, en curso):** el resto del diseño de fondo de la auditoría del 2 ago — fallo silencioso del webhook si `message.from` falta (jerarquía de respaldo `from → contacts.wa_id → leadgen → alerta`), condición de carrera, seguimiento genérico, formulario duplicado. Ver `docs/PENDIENTES.md`.

### 6.4 Incidente — `cmd=todo` en `/control` vació la tabla `pausados` completa (2 ago 2026)

**Qué pasó:** se ejecutó `cmd=pausatodo` seguido de `cmd=todo` en `/control`. `cmd=todo` no solo quita la pausa global — también llama a `quitarTodosPausados()`, que hace `DELETE FROM pausados` sin condición. Efecto real: los ~126 números que estaban pausados manualmente (leads en "🔵 Atendiendo yo") quedaron sin protección — Olivia habría vuelto a responderles automáticamente.

**Causa raíz de fondo:** `cmd=todo` mezcla dos cosas que deberían ser independientes — "quitar la pausa global" (`pausadoTodo=false`) y "reactivar todos los números pausados individualmente" (`quitarTodosPausados()`). Además, ninguna acción de `/control` (`pausa`, `reanudar`, `pausatodo`, `todo`, `cerrado_venta`, etc.) queda registrada en `lead_events` ni en ningún log — son completamente silenciosas, lo que hizo la reconstrucción muy difícil. **Pendiente de rediseño, no corregido todavía** — ver `docs/PENDIENTES.md`.

**Reconstrucción:** no fue posible recuperar la lista completa de 126 (`lead_events` no tiene eventos de pausa; el log de arranque solo loguea el conteo, no los números; los comandos de `/control` no dejan rastro ni en logs de aplicación ni en logs HTTP — Railway no captura el query string). Se reconstruyeron 10 números con alta confianza cruzando tres señales independientes (logs de escalamiento automático desde el arranque del 30 jul, `leads.owner='LILI'`, y notas manuales) y se restauraron en `pausados` con un `INSERT ... ON CONFLICT DO NOTHING` (aprobado por Lili, ejecutado 2 ago 2026). **Quedan potencialmente ~116 números sin restaurar** — pendiente que Lili revise si Railway tiene point-in-time recovery en el plan de Postgres, o si recuerda otros números para agregar.

**Mitigación desplegada — feature flag `REACTIVACION_12_19_ENABLED`:** mientras se corrige el resto del sistema de seguimiento (texto "repisa" hardcodeado sin importar el producto — ver Punto 1 del diagnóstico en `docs/PENDIENTES.md`), el cron de reactivación de 12pm/7pm (`whatsapp_agent.js`, cerca de la línea 1086) queda **apagado por defecto** — mismo patrón que `COTIZADOR_REPISAS_V2_ENABLED` (variable ausente o distinta de `'true'` = apagado). Se activa poniendo `REACTIVACION_12_19_ENABLED=true` en Railway (requiere redeploy). El cron horario de seguimiento (`esperando_info`/`esperando_decision`/`cotizacion_enviada`, otro `setInterval` distinto) y las respuestas en tiempo real de Olivia **no se tocaron** — siguen funcionando normal. Pruebas: `test/reactivacion-1219-flag.test.js` (3 casos: default apagado, valores no-`'true'` apagado, `'true'` exacto activa).

**Pendiente:** implementar el resto del diseño de Fase 2 (producto real en los mensajes de seguimiento, guard síncrono de la condición de carrera, notificación a Lili que no dependa de `message.from`, etc. — diagnóstico completo y diseño en la conversación de auditoría del 2 ago, resumen en `docs/PENDIENTES.md`) antes de volver a activar `REACTIVACION_12_19_ENABLED`.

---

## 7. PENDIENTES CONOCIDOS
- Vistas nuevas en el panel para datos del CRM/cotizador
- `MESSAGE_SENT_BY_OLIVIA` sin conectar (pospuesto a propósito)
- Postgres real de prueba para validar `ON CONFLICT`/`UNIQUE`
- **Repisas entamboradas** (espesor 4.5/5.4cm, instalación con listones) — sin despiece/cálculo definido
- Descuento por volumen (cantidad>1) — no implementado
- Interpolación entre medidas — descartada a favor de fórmula completa
- Panel sin paginar (~164KB por carga) — riesgo de lentitud futura
- Revisar si Meta permite forzar "formulario primero"

---

## 8. LECCIONES APRENDIDAS
1. Nunca pegar código largo en editor web de GitHub — usar Claude Code con repo clonado
2. `node --test` puede colgarse en Windows — envolver `setInterval` en `if (require.main === module)`
3. `pg-mem` da resultados incorrectos en `ON CONFLICT DO NOTHING RETURNING` — usar mocks documentando el límite
4. Railway sin backups automáticos — respaldo manual antes de migraciones
5. Reglas de texto pueden solaparse — mejor auto-limitar cada bloque a su escenario que declarar "prioridad" abstracta
6. Nunca dejar que el modelo calcule aritmética de precios en texto — siempre JS determinístico
7. Palabras clave de detección deben ser frases específicas, no palabras sueltas genéricas
8. Una regla dentro del documento maestro no garantiza que una IA lo abra:
   también debe existir en los archivos de entrada de cada herramienta
   (`AGENTS.md` y `CLAUDE.md`) y tener una comprobación automática en GitHub.

---

## 9. CÓMO USAR ESTE DOCUMENTO CON OTRA IA DISTINTA A CLAUDE CODE
1. Dale acceso al repo `lilihurt13/agente-whatsapp`
2. Pégale este documento completo como contexto inicial
3. Dile en qué sección estás trabajando
4. Pídele que revise `docs/PENDIENTES.md` y `docs/COTIZADOR_V2_PLAN.md` en el repo
5. Mantén la misma disciplina: rama nueva, diagnóstico antes de código, pruebas antes de commit, autorización antes de push — independiente de qué IA lo ejecute
6. **Recuérdale explícitamente la regla de la sección "REGLA FIJA" al inicio de este documento** — que debe actualizar este mismo archivo al cerrar su sesión de trabajo, sin que se le tenga que pedir cada vez. Esto aplica igual si es Claude Code, ChatGPT Codex, o cualquier otra herramienta.

---

*Fin del documento. Este documento es de actualización OBLIGATORIA — no opcional — al cierre de cualquier sesión de trabajo, sin importar el tamaño del cambio. Ver la sección "REGLA FIJA" al inicio.*
