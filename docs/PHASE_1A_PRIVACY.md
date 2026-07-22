# Fase 1A — Payload Raw y Política de Retención (Sección 8)

Este documento cubre lo que la sección 8 del prompt de Fase 1A pedía:
identificar si los datos crudos que guardamos contienen secretos, y
documentar una política de retención — antes de decidir si hacía falta
una tabla `webhook_events` genérica (decisión: no, ver más abajo).

## 1. Qué se guarda como "raw payload" hoy

| Tabla | Columna | Contenido |
|---|---|---|
| `messages` | `raw_payload` (JSONB) | El objeto `message` completo que manda Meta por cada mensaje de WhatsApp procesado (texto, imagen, audio, documento, y el mensaje saliente de Lili detectado vía webhook) |
| `lead_form_submissions` | `field_data` (JSONB) | Las respuestas del formulario de Lead Ads, tal como las devuelve la Graph API (`GET /{leadgen_id}?fields=field_data`) |
| `leads` | `referral_data`, `lead_form_data` (JSONB) | Subconjunto ya extraído de lo anterior, asociado al lead |

## 2. ¿Contienen tokens o secretos?

**No.** Verificado por inspección de la estructura real de estos payloads:

- El objeto `message` de WhatsApp (`messages.raw_payload`) contiene: `id`,
  `from`, `to`, `timestamp`, `type`, contenido del mensaje (`text.body`,
  IDs de media), y opcionalmente `referral` (URLs de anuncio, headline,
  `ctwa_clid`). Ninguno de estos campos es un token de autenticación —
  los tokens (`META_API_TOKEN`, `ANTHROPIC_API_KEY`, `META_APP_SECRET`,
  etc.) viven exclusivamente en variables de entorno y nunca forman parte
  del cuerpo de un webhook entrante de Meta.
- `field_data` de Lead Ads contiene las respuestas que el cliente potencial
  escribió en el formulario (nombre, teléfono, email, respuestas
  personalizadas) — es información personal (PII) del lead, no un secreto
  de la aplicación. Es exactamente el tipo de dato que la Fase 1A busca
  capturar (ver sección 7).

## 3. ¿Se necesita enmascarar algo antes de guardarlo?

No se aplicó ningún enmascaramiento adicional porque no hay nada que
enmascarar en estos payloads específicos (ver punto 2). La única regla que
sí se mantiene en todo el código nuevo: **los `console.log`/`console.error`
nunca imprimen el contenido completo de `field_data` ni de mensajes
sensibles** — solo IDs, nombres de campo, y conteos (ver los logs de
`REFERRAL_CAPTURED` y `LEAD_FORM_DATA_RETRIEVED` en el código). El
contenido completo vive únicamente en Postgres, no en logs de Railway.

## 4. Política de retención

**Se conserva indefinidamente por ahora — sin cambio respecto a la
práctica ya existente.** El sistema legacy (`conversaciones`, `notas`)
tampoco tiene ningún mecanismo de expiración o borrado automático hoy; la
Fase 1A no introduce un riesgo de retención nuevo, solo lo extiende a las
tablas nuevas con el mismo criterio.

Si más adelante se requiere una política de borrado o anonimización (por
ejemplo, por cumplimiento de protección de datos), es una decisión
separada y explícita — no implícita en esta fase.

## 5. Decisión: no se crea `webhook_events`

Se evaluó crear una tabla genérica `webhook_events` (payload crudo de
*todo* webhook recibido, sin importar el tipo) como proponía la sección 8
del prompt original. Se decidió **no crearla** porque los dos caminos que
necesitaban retención de payload crudo ya la tienen, con mejor contexto
(asociados a un lead) que un log genérico:

- Mensajes de WhatsApp → `messages.raw_payload`
- Formularios de Lead Ads → `lead_form_submissions.field_data`

Lo único sin persistir es `value.statuses` (confirmaciones de entrega/
lectura/fallo), que ya tiene una señal en tiempo real vía `notificarLili()`
(Telegram) — sin cambios en esta fase. Ninguno de los 10 eventos del
catálogo cerrado de la sección 10 cubre "entrega fallida", así que
añadir persistencia para ese caso sería expandir el alcance aprobado de
la Fase 1A sin autorización explícita.
