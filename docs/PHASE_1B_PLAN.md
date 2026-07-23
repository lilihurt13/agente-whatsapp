# Fase 1B — Personalización del primer mensaje con datos de formulario

## Objetivo
Cuando un lead responde uno de los 3 formularios de Lead Ads (Repisa,
Mesa Auxiliar, Escritorio) y su primer mensaje real llega por WhatsApp,
Olivia no repite el saludo largo (Meta ya lo mostró dentro del propio
formulario) — va directo a reconocer las respuestas, confirmar
características y precio (características antes que precio, siempre), y
cerrar con una pregunta de acción concreta.

## Qué se implementó
- `obtenerFormularioVinculadoReciente(leadId)` — busca el
  `lead_form_submissions` VINCULADO más reciente, dentro de una ventana de
  **48 horas** desde que llegó el evento leadgen (decisión de Lili: "el
  ciclo de decisión del cliente puede tomar unos días").
- `detectarProductoFormulario(fieldData)` — identifica el producto
  (Repisa/Mesa Auxiliar/Escritorio) buscando palabras clave tanto en los
  nombres de campo (`name`) como en los **valores elegidos** (`values`),
  que suelen traer el texto completo de la opción seleccionada.
- `formatearRespuestasFormulario(submission)` — arma el bloque de texto
  para el system prompt, excluyendo nombre/teléfono.
- `procesarMensaje(from, texto, leadId)` — cuando hay formulario vinculado
  reciente en el primer mensaje del lead: fuerza `esPrimerMensaje = false`
  (evita el saludo promocional fijo) e inyecta el bloque de respuestas +
  una instrucción explícita al system prompt, reutilizando las reglas de
  precio/características por producto que **ya existen** en
  `getSystemPrompt()` — no se reescribió ninguna regla comercial.
- Fotos del producto: se siguen enviando también para leads de formulario
  (decisión confirmada por Lili).

## ⚠️ Validación pendiente: nombres reales de los campos del formulario

**Se intentó validar contra un payload real antes de desplegar, sin
éxito**, por una cadena de bloqueos externos (23 jul 2026):
1. La herramienta de Lead Ads Testing no encontraba los formularios.
2. La biblioteca de Formularios Instantáneos en Meta Business Suite
   apareció vacía.
3. Ubicado el ID del anuncio en borrador (`120249824347180573`) vía la
   URL de Ads Manager, pero la consulta a la Graph API Explorer
   (`{ad_id}?fields=creative{object_story_spec}`) falló por permisos del
   token generado (`GraphMethodException`, code 100, subcode 33).

**Decisión**: proceder sin validación en vivo, dado que `detectarProductoFormulario()`
está diseñada para degradar con seguridad — si no reconoce el producto,
de todas formas le pasa a Claude las preguntas y respuestas crudas del
formulario (sin el nombre del producto en el encabezado). No es un fallo
funcional, es una pérdida de precisión en el peor caso.

## Cómo verificar con el primer lead real (después del lanzamiento)

1. En Railway → Deploy Logs, buscar la línea `📋 Contexto de formulario aplicado al primer mensaje de <número>` — confirma que el bloque se inyectó.
2. Consultar (con el mismo método de `scripts/ver_ultimo_formulario.js`) la fila de `lead_form_submissions` de ese lead — revisar el `field_data` real y comparar contra las palabras clave de `CLAVES_PRODUCTO_FORMULARIO` en `whatsapp_agent.js`.
3. Si el producto detectado es incorrecto o queda en `null`, ajustar la lista de palabras clave con los nombres/valores reales ya confirmados — cambio de una sola constante, sin tocar el resto de la lógica.
4. Revisar manualmente la primera respuesta real de Olivia a ese lead en el panel — confirmar que no repitió el saludo largo y que siguió el orden características→precio→cierre.
