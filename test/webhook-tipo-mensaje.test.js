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
//
// 🆕 ETAPA 1 (3 ago 2026) — jerarquía de resolución del remitente
// (message.from → value.contacts[0].wa_id → alerta sin número). Caso real:
// lead "Yuly", cuyo message.from llegó vacío/corrupto pero value.contacts
// sí traía el wa_id real. `tipoDeMensajeEsManejado()` ahora recibe el
// número YA resuelto (tercer parámetro) en vez de leer message.from
// directamente — resolverNumeroRemitente() es la única fuente de verdad
// para esa resolución.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('tipoDeMensajeEsManejado — texto entrante con número ya resuelto es manejado', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: '573001112233' }, false, '573001112233'), true);
});

test('tipoDeMensajeEsManejado — texto saliente de Lili (esSaliente=true) es manejado aunque numeroResuelto sea null', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: 'PHONE_NUMBER_ID_SIMULADO' }, true, null), true);
});

test('tipoDeMensajeEsManejado — image/video/audio/document con número resuelto son manejados', function() {
  ['image', 'video', 'audio', 'document'].forEach(function(tipo) {
    assert.equal(app.tipoDeMensajeEsManejado({ type: tipo, from: '573001112233' }, false, '573001112233'), true, 'tipo=' + tipo);
  });
});

test('tipoDeMensajeEsManejado — sin número resuelto (null) NO es manejado (antes se perdía en silencio)', function() {
  assert.equal(app.tipoDeMensajeEsManejado({ type: 'text', from: 'no-es-un-numero' }, false, null), false);
});

test('tipoDeMensajeEsManejado — tipos que Meta puede mandar y el código nunca contempló NO son manejados aunque haya número resuelto', function() {
  ['interactive', 'button', 'contacts', 'location', 'sticker', 'reaction', 'order', 'system', 'unsupported'].forEach(function(tipo) {
    assert.equal(app.tipoDeMensajeEsManejado({ type: tipo, from: '573001112233' }, false, '573001112233'), false, 'tipo=' + tipo);
  });
});

test('tipoDeMensajeEsManejado — mensaje null/undefined nunca lanza excepción', function() {
  assert.equal(app.tipoDeMensajeEsManejado(null, false, null), false);
  assert.equal(app.tipoDeMensajeEsManejado(undefined, false, null), false);
});

test('resolverNumeroRemitente — message.from válido gana, ni siquiera mira contacts', function() {
  assert.equal(
    app.resolverNumeroRemitente({ from: '573001112233' }, [{ wa_id: '573009998877' }]),
    '573001112233'
  );
});

test('resolverNumeroRemitente — caso real "Yuly": from vacío, contacts.wa_id rescata el número', function() {
  assert.equal(
    app.resolverNumeroRemitente({ from: '' }, [{ wa_id: '573001112233' }]),
    '573001112233'
  );
});

test('resolverNumeroRemitente — from inválido (no numérico) también cae al respaldo de contacts', function() {
  assert.equal(
    app.resolverNumeroRemitente({ from: 'no-es-un-numero' }, [{ wa_id: '573001112233' }]),
    '573001112233'
  );
});

test('resolverNumeroRemitente — sin from y sin contacts devuelve null (nunca inventa)', function() {
  assert.equal(app.resolverNumeroRemitente({ from: null }, undefined), null);
  assert.equal(app.resolverNumeroRemitente({ from: null }, []), null);
});

test('resolverNumeroRemitente — contacts[0].wa_id inválido también devuelve null', function() {
  assert.equal(app.resolverNumeroRemitente({ from: null }, [{ wa_id: 'no-es-un-numero' }]), null);
});

test('resolverNumeroRemitente — message null/undefined nunca lanza excepción', function() {
  assert.equal(app.resolverNumeroRemitente(null, null), null);
  assert.equal(app.resolverNumeroRemitente(undefined, undefined), null);
});
