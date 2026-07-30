// ═══════════════════════════════════════════════════════════════════════════
// Fallo silencioso del webhook (29 jul 2026) — lead real "María" cuyo mensaje
// nunca produjo "🆕 Lead creado" ni "Mensaje de...", sin ningún error en
// logs. Causa raíz: ninguno de los `if` de tipo de mensaje del webhook tenía
// un `else`, así que un message.type no contemplado (interactive, button,
// contacts, location, sticker, reaction, order, system, unsupported...) o un
// `from` que no pasara esNumeroValido caían entre todas las condiciones sin
// loguear nada. `tipoDeMensajeEsManejado()` es la función pura extraída del
// webhook que decide esto — se prueba aquí en vez de contra el endpoint HTTP
// completo porque el resto de la suite (Casos A-H) tampoco monta el webhook
// real (evita tener que simular la firma de Meta), y prueba la lógica de
// orquestación llamando directamente a las funciones internas expuestas en
// `app`.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('tipoDeMensajeEsManejado — texto entrante de un número válido es manejado', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: '573001112233' }, false), true);
});

test('tipoDeMensajeEsManejado — texto saliente de Lili (esSaliente=true) es manejado', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: 'PHONE_NUMBER_ID_SIMULADO' }, true), true);
});

test('tipoDeMensajeEsManejado — image/video/audio/document de un número válido son manejados', function() {
  ['image', 'video', 'audio', 'document'].forEach(function(tipo) {
    assert.equal(app.tipoDeMensajeEsManejado({ type: tipo, from: '573001112233' }, false), true, 'tipo=' + tipo);
  });
});

test('tipoDeMensajeEsManejado — texto de un "from" que no pasa esNumeroValido NO es manejado (antes se perdía en silencio)', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: 'no-es-un-numero' }, false), false);
});

test('tipoDeMensajeEsManejado — tipos que Meta puede mandar y el código nunca contempló NO son manejados', function() {
  ['interactive', 'button', 'contacts', 'location', 'sticker', 'reaction', 'order', 'system', 'unsupported'].forEach(function(tipo) {
    assert.equal(app.tipoDeMensajeEsManejado({ type: tipo, from: '573001112233' }, false), false, 'tipo=' + tipo);
  });
});

test('tipoDeMensajeEsManejado — mensaje null/undefined nunca lanza excepción', function() {
  assert.equal(app.tipoDeMensajeEsManejado(null, false), false);
  assert.equal(app.tipoDeMensajeEsManejado(undefined, false), false);
});
