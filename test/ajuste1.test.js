// ═══════════════════════════════════════════════════════════════════════════
// Ajuste 1 — Olivia usa leads.referral_data para anclar el saludo al
// producto correcto cuando el lead no menciona el producto ni llenó el
// formulario. Mismo límite de siempre: pruebas puras, sin mockear axios/Claude.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('detectarProductoDesdeReferral — reconoce Repisa por el headline real de producción', function() {
  const producto = app.detectarProductoDesdeReferral({
    headline: 'Gracias por interesarte en nuestras repisas flotantes',
    body: '60x15x3.6cm por $220.000'
  });
  assert.equal(producto, 'Repisa Flotante');
});

test('detectarProductoDesdeReferral — reconoce Mesa Auxiliar por el body', function() {
  const producto = app.detectarProductoDesdeReferral({
    headline: 'Anúnciate con nosotros',
    body: 'Nuestra mesa auxiliar Compacta queda perfecta en cualquier espacio'
  });
  assert.equal(producto, 'Mesa Auxiliar');
});

test('detectarProductoDesdeReferral — reconoce Escritorio por source_url', function() {
  const producto = app.detectarProductoDesdeReferral({
    source_url: 'https://hechoporlili.com/escritorio-flotante-promo'
  });
  assert.equal(producto, 'Escritorio Flotante');
});

test('detectarProductoDesdeReferral — bug real 27 jul: anuncio de Escritorio ya no cae en falso positivo de Mesa Auxiliar', function() {
  // Antes del Paso A, 'versión'/'compacta' estaban en las claves de Mesa
  // Auxiliar y Mesa Auxiliar se evaluaba antes que Escritorio en
  // CLAVES_PRODUCTO_FORMULARIO — cualquier anuncio de Escritorio que usara
  // esas palabras genéricas en su copy ganaba el falso positivo.
  const producto = app.detectarProductoDesdeReferral({
    headline: 'El escritorio flotante del anuncio',
    body: 'Nueva versión compacta, mide 75×45×15cm, vale $1.590.000'
  });
  assert.equal(producto, 'Escritorio Flotante');
});

test('detectarProductoDesdeReferral — sin referral_data devuelve null (no rompe)', function() {
  assert.equal(app.detectarProductoDesdeReferral(null), null);
  assert.equal(app.detectarProductoDesdeReferral({}), null);
  assert.equal(app.detectarProductoDesdeReferral({ ctwa_clid: 'abc' }), null); // sin headline/body/source_url reconocible
});

test('formatearContextoReferral — arma el bloque con headline y body', function() {
  const bloque = app.formatearContextoReferral({
    headline: 'Gracias por interesarte en nuestras repisas flotantes',
    body: '60x15x3.6cm por $220.000'
  }, 'Repisa Flotante');

  assert.ok(bloque.indexOf('Repisa Flotante') !== -1);
  assert.ok(bloque.indexOf('repisas flotantes') !== -1);
  assert.ok(bloque.indexOf('220.000') !== -1);
});

test('formatearContextoReferral — sin headline ni body devuelve null', function() {
  assert.equal(app.formatearContextoReferral({ ad_id: '123' }, null), null);
  assert.equal(app.formatearContextoReferral(null, null), null);
});

test('detectarProductoPorTexto — núcleo compartido, usado por formulario y referral', function() {
  // Verifica que el refactor no rompió la detección del formulario (Fase 1B)
  const productoFormulario = app.detectarProductoFormulario([
    { name: 'donde_necesitas_la_repisa', values: ['Medellín'] }
  ]);
  assert.equal(productoFormulario, 'Repisa Flotante');

  // Y que el mismo núcleo funciona igual para referral
  const productoReferral = app.detectarProductoDesdeReferral({ headline: 'Nuestra repisa flotante en roble' });
  assert.equal(productoReferral, 'Repisa Flotante');
});
