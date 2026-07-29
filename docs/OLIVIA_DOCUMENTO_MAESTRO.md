# DOCUMENTO MAESTRO — Proyecto Olivia (Hecho por Lili)

**Última actualización:** 27 de julio de 2026
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
1. Lili abre Claude Code en su computador (`~/Documents/agente-whatsapp`), ejecuta `claude`
2. Trabajo por fases: rama nueva → diagnóstico → plan aprobado por Lili (vía Claude.ai como supervisor) → código → pruebas → resumen → commit (solo en rama) → **push a main solo con autorización explícita de Lili**
3. Railway redespliega automáticamente al detectar push a `main`
4. **Regla de oro:** nunca commitear/pushear sin que Lili vea el resumen y las pruebas primero

### 2.3 Variables de entorno críticas (Railway → Variables, nunca en código)
`META_API_TOKEN`, `PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `ANTHROPIC_API_KEY`, `CONTROL_TOKEN`, `LILI_NUMERO`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`, `DATABASE_URL`/`DATABASE_PUBLIC_URL`, y **`COTIZADOR_REPISAS_V2_ENABLED`** (feature flag, ver sección 5).

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

### 6.1 Fotos enviadas sin que el cliente las pida
Lead de Mesa Auxiliar recibió fotos correctas en el saludo, pero en mensaje posterior ("para sala", sin pedir fotos) Olivia disparó `[FOTOS_EXTRA]` con fotos equivocadas (Repisa). Regla confirmada: 2 fotos del saludo son suficientes por defecto; no enviar más solo porque la conversación avanza — solo si el cliente pide explícitamente, o si falta un detalle específico (ahí escalar, nunca enviar foto sustituta). Pendiente: diagnóstico con historial real.

### 6.2 El formulario de Lead Ads parece no aportar nada
Sospecha de Lili: Olivia no está usando datos de formulario (ciudad, versión) en conversaciones reales. Pendiente: contar `lead_form_submissions` VINCULADO vs PENDIENTE, y revisar si Olivia usa los vinculados o los ignora.

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
