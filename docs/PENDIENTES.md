# Pendientes — no urgentes, revisar en sesión futura

## El formulario de Lead Ads no es obligatorio de facto

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
