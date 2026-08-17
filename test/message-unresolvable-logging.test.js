// ═══════════════════════════════════════════════════════════════════════════
// Caso real "Lina De Brigard" (5 ago 2026) — llegó un lead por formulario a
// las 11:13, pero el mensaje de chat real que envió 2 segundos después no
// pudo resolver número (ni message.from ni contacts[0].wa_id) y se descartó
// sin dejar ningún rastro persistente — imposible reconstruir la forma real
// del payload que causó el fallo. `sanitizarPayloadWebhook()` es la función
// pura que prepara ese payload para loguearse/persistirse completo (única
// excepción a la regla de "nunca loguear el payload completo", ver
// docs/PHASE_1A_PRIVACY.md) cuando esto vuelva a ocurrir.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('sanitizarPayloadWebhook — redacta claves que lucen como token/secret/password/api_key en cualquier nivel de anidamiento', function() {
  var sucio = {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: '123', access_token: 'shhh', display_phone_number: '+57 300 000 0000' },
    contacts: [{ profile: { name: 'Lina' }, wa_id: '573168328198' }],
    messages: [{
      id: 'wamid.ABC',
      type: 'text',
      text: { body: 'hola' },
      nested: { apiKey: 'xyz', Authorization: 'Bearer x', api_key: 'y', PASSWORD: 'z' }
    }]
  };
  var limpio = app.sanitizarPayloadWebhook(sucio);
  assert.equal(limpio.metadata.access_token, '[REDACTADO]');
  assert.equal(limpio.messages[0].nested.apiKey, '[REDACTADO]');
  assert.equal(limpio.messages[0].nested.Authorization, '[REDACTADO]');
  assert.equal(limpio.messages[0].nested.api_key, '[REDACTADO]');
  assert.equal(limpio.messages[0].nested.PASSWORD, '[REDACTADO]');
});

test('sanitizarPayloadWebhook — no toca campos normales de contacts/messages', function() {
  var sucio = {
    contacts: [{ profile: { name: 'Lina' }, wa_id: '573168328198' }],
    messages: [{ id: 'wamid.ABC', type: 'text', text: { body: 'hola' } }]
  };
  var limpio = app.sanitizarPayloadWebhook(sucio);
  assert.equal(limpio.contacts[0].wa_id, '573168328198');
  assert.equal(limpio.contacts[0].profile.name, 'Lina');
  assert.equal(limpio.messages[0].text.body, 'hola');
});

test('sanitizarPayloadWebhook — no muta el objeto original', function() {
  var original = { secret_key: 'abc', normal: 1 };
  var limpio = app.sanitizarPayloadWebhook(original);
  assert.equal(original.secret_key, 'abc');
  assert.equal(limpio.secret_key, '[REDACTADO]');
});

test('sanitizarPayloadWebhook — null/undefined/primitivos no lanzan excepción y se devuelven igual', function() {
  assert.equal(app.sanitizarPayloadWebhook(null), null);
  assert.equal(app.sanitizarPayloadWebhook(undefined), undefined);
  assert.equal(app.sanitizarPayloadWebhook('texto'), 'texto');
  assert.equal(app.sanitizarPayloadWebhook(42), 42);
});

test('sanitizarPayloadWebhook — arrays anidados se recorren igual que objetos', function() {
  var sucio = [{ token: 'x' }, { ok: 1 }];
  var limpio = app.sanitizarPayloadWebhook(sucio);
  assert.equal(limpio[0].token, '[REDACTADO]');
  assert.equal(limpio[1].ok, 1);
});
