// ═══════════════════════════════════════════════════════════════════════════
// Fix (26 jul) — condición de carrera confirmada con el lead real
// 573138910346 (id=11): capturarReferral() escribe a la BD de forma
// async/fire-and-forget y nunca muta el objeto `lead` en memoria. Cuando el
// referral llega en el mismo mensaje que crea el lead, la lectura de
// resultadoCRM.lead.referral_data ganaba la carrera contra la escritura.
//
// Estas pruebas cubren construirReferralParaContexto(), la función pura que
// resuelve el problema combinando lo guardado en la BD con el referral del
// mensaje actual (más fresco, tiene prioridad).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('construirReferralParaContexto — caso exacto del bug: lead nuevo (referral_data vacío) + referral en el mensaje actual', function() {
  const referralGuardado = {}; // lead recién creado, sin nada guardado todavía
  const messageReferral = {
    headline: 'Gracias por interesarte en nuestras repisas flotantes',
    body: '60x15x3.6cm por $220.000'
  };

  const resultado = app.construirReferralParaContexto(referralGuardado, messageReferral);

  assert.equal(resultado.headline, 'Gracias por interesarte en nuestras repisas flotantes');
  assert.equal(resultado.body, '60x15x3.6cm por $220.000');

  // Y con eso, la detección de producto (Ajuste 1) debe funcionar correctamente —
  // esto es justo lo que fallaba en producción para el lead 573138910346.
  const producto = app.detectarProductoDesdeReferral(resultado);
  assert.equal(producto, 'Repisa Flotante');
});

test('construirReferralParaContexto — respaldo: mensaje posterior sin referral propio usa lo ya guardado', function() {
  const referralGuardado = { headline: 'Nuestra mesa auxiliar Compacta', ad_id: 'AD123' };
  const messageReferral = null; // este mensaje posterior no trae su propio referral

  const resultado = app.construirReferralParaContexto(referralGuardado, messageReferral);

  assert.equal(resultado.headline, 'Nuestra mesa auxiliar Compacta');
  assert.equal(resultado.ad_id, 'AD123');
});

test('construirReferralParaContexto — merge: el referral del mensaje actual tiene prioridad sobre lo guardado', function() {
  const referralGuardado = { headline: 'Titular viejo', ad_id: 'AD-VIEJO' };
  const messageReferral = { headline: 'Titular nuevo del anuncio de escritorio' };

  const resultado = app.construirReferralParaContexto(referralGuardado, messageReferral);

  assert.equal(resultado.headline, 'Titular nuevo del anuncio de escritorio', 'el headline del mensaje actual debe ganar');
  assert.equal(resultado.ad_id, 'AD-VIEJO', 'los campos que el mensaje actual no trae se conservan del guardado');
});

test('construirReferralParaContexto — sin nada guardado ni referral en el mensaje devuelve objeto vacío (no rompe)', function() {
  const resultado = app.construirReferralParaContexto(null, null);
  assert.deepEqual(resultado, {});
  assert.equal(app.detectarProductoDesdeReferral(resultado), null);
  assert.equal(app.formatearContextoReferral(resultado, null), null);
});
