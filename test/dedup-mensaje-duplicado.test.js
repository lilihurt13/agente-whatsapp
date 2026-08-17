// ═══════════════════════════════════════════════════════════════════════════
// Deduplicación determinística de formulario repetido (auditoría 2 ago
// 2026, caso real Deissy): cuando un cliente reenvía el mismo texto del
// formulario (reenvío técnico, mismo número, mismo contenido), Olivia lo
// trataba como mensaje nuevo y repetía el saludo/pregunta ya respondidos.
//
// detectarMensajeDuplicado(historial, textoActual) es la función pura
// extraída de procesarMensaje() que decide esto — se prueba aquí en vez de
// contra el flujo completo (mismo criterio que el resto de la suite: no se
// monta el webhook/Claude real). `historial` debe incluir el mensaje actual
// como último elemento, igual que conversaciones[from] en producción
// (agregarMensaje() ya lo agregó antes de llamar a procesarMensaje()).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

const TEXTO_FORMULARIO_DEISSY = 'Hola, quiero cotizar la repisa flotante de roble, Bogotá, la necesito para pronto';

test('detectarMensajeDuplicado — caso real Deissy: mismo texto ya respondido SÍ dispara duplicado', function() {
  const historial = [
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 1 },
    { role: 'assistant', content: 'Hola! Con gusto te cuento...', ts: 2 },
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 3 } // reenvío técnico del mismo formulario
  ];
  assert.equal(app.detectarMensajeDuplicado(historial, TEXTO_FORMULARIO_DEISSY), true);
});

test('detectarMensajeDuplicado — texto parecido pero NO idéntico no dispara duplicado', function() {
  const textoParecido = TEXTO_FORMULARIO_DEISSY + '.'; // un punto de diferencia
  const historial = [
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 1 },
    { role: 'assistant', content: 'Hola! Con gusto te cuento...', ts: 2 },
    { role: 'user', content: textoParecido, ts: 3 }
  ];
  assert.equal(app.detectarMensajeDuplicado(historial, textoParecido), false);
});

test('detectarMensajeDuplicado — texto idéntico pero SIN respuesta previa no dispara duplicado (aún no se había respondido)', function() {
  const historial = [
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 1 },
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 2 } // reintento antes de que Olivia alcanzara a responder
  ];
  assert.equal(app.detectarMensajeDuplicado(historial, TEXTO_FORMULARIO_DEISSY), false);
});

test('detectarMensajeDuplicado — primer mensaje de la conversación (sin historial previo) no dispara duplicado', function() {
  const historial = [{ role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 1 }];
  assert.equal(app.detectarMensajeDuplicado(historial, TEXTO_FORMULARIO_DEISSY), false);
});

test('detectarMensajeDuplicado — solo compara contra el ÚLTIMO mensaje user, no contra todo el historial', function() {
  // El mensaje de hace 2 turnos coincide, pero el INMEDIATAMENTE anterior no —
  // no debe marcarse como duplicado (el diseño compara solo el más reciente).
  const historial = [
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 1 },
    { role: 'assistant', content: 'Hola! Con gusto te cuento...', ts: 2 },
    { role: 'user', content: 'Otra pregunta distinta', ts: 3 },
    { role: 'assistant', content: 'Claro, te explico...', ts: 4 },
    { role: 'user', content: TEXTO_FORMULARIO_DEISSY, ts: 5 } // coincide con ts=1, no con ts=3
  ];
  assert.equal(app.detectarMensajeDuplicado(historial, TEXTO_FORMULARIO_DEISSY), false);
});

test('detectarMensajeDuplicado — historial vacío o null nunca lanza excepción', function() {
  assert.equal(app.detectarMensajeDuplicado([], 'algo'), false);
  assert.equal(app.detectarMensajeDuplicado(null, 'algo'), false);
  assert.equal(app.detectarMensajeDuplicado(undefined, 'algo'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Guard contra falso positivo con placeholders de media: dos fotos DISTINTAS
// comparten el mismo texto genérico "[El cliente envió una imagen]" — esta
// verificación vive en procesarMensaje() (esPlaceholderMedia), no dentro de
// detectarMensajeDuplicado() en sí (que es agnóstica al tipo de contenido).
// Documentado aquí para dejar constancia del criterio, no como prueba de la
// función pura (que correctamente SÍ marcaría esto como "duplicado" si se
// le pasara el placeholder directamente — el guard vive un nivel arriba).
// ─────────────────────────────────────────────────────────────────────────
test('detectarMensajeDuplicado — dos placeholders de media idénticos por diseño (el guard real está en procesarMensaje, no aquí)', function() {
  const placeholder = '[El cliente envió una imagen]';
  const historial = [
    { role: 'user', content: placeholder, ts: 1 },
    { role: 'assistant', content: 'Qué linda referencia!', ts: 2 },
    { role: 'user', content: placeholder, ts: 3 } // en realidad es una foto DISTINTA
  ];
  assert.equal(app.detectarMensajeDuplicado(historial, placeholder), true, 'la función pura no distingue media de texto — por eso procesarMensaje() la excluye para placeholders');
});
