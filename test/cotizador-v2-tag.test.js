// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — FASE 3 de integración: parser puro del tag
// interno [COTIZAR_REPISA:...]. Todavía NO conectado a procesarMensaje()
// ni al webhook — ver docs/COTIZADOR_V2_PLAN.md.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('extraerTagCotizarRepisa — parsea un tag válido completo', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  assert.equal(r.tagEncontrado, true);
  assert.equal(r.largoCm, 70);
  assert.equal(r.profundidadCm, 20);
  assert.equal(r.cantidad, 1);
  assert.equal(r.ciudad, 'Medellín');
  assert.equal(r.modalidadTag, 'instalado_medellin');
  assert.equal(r.elegibleParaCalculoAutomatico, true);
});

test('extraerTagCotizarRepisa — encuentra el tag aunque venga rodeado de otro texto', function() {
  const r = app.extraerTagCotizarRepisa('Claro, dame un segundo 😊 [COTIZAR_REPISA:largo=60,prof=15,cantidad=1,ciudad=Bogotá,modalidad=envio_nacional] gracias por tu paciencia');
  assert.ok(r);
  assert.equal(r.largoCm, 60);
  assert.equal(r.profundidadCm, 15);
});

test('extraerTagCotizarRepisa — sin tag en el texto devuelve null', function() {
  assert.equal(app.extraerTagCotizarRepisa('Hola, ¿en qué te puedo ayudar? 😊'), null);
  assert.equal(app.extraerTagCotizarRepisa(''), null);
  assert.equal(app.extraerTagCotizarRepisa(null), null);
  assert.equal(app.extraerTagCotizarRepisa(undefined), null);
});

test('extraerTagCotizarRepisa — tag mal formado (sin largo/prof numéricos) devuelve null', function() {
  assert.equal(app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=abc,prof=20,cantidad=1,modalidad=instalado_medellin]'), null);
  assert.equal(app.extraerTagCotizarRepisa('[COTIZAR_REPISA:prof=20,cantidad=1,modalidad=instalado_medellin]'), null);
  assert.equal(app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=0,prof=20,cantidad=1]'), null, 'largo=0 no es una medida válida');
});

test('extraerTagCotizarRepisa — cantidad ausente por defecto es 1 y elegible', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,modalidad=instalado_medellin]');
  assert.equal(r.cantidad, 1);
  assert.equal(r.elegibleParaCalculoAutomatico, true);
});

test('extraerTagCotizarRepisa — decisión de negocio: cantidad > 1 NO es elegible para cálculo automático', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,cantidad=3,ciudad=Medellín,modalidad=instalado_medellin]');
  assert.equal(r.cantidad, 3);
  assert.equal(r.elegibleParaCalculoAutomatico, false, 'cantidad > 1 siempre debe escalar, no calcular automático');
});

test('extraerTagCotizarRepisa — traduce instalado_medellin → instalado', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,modalidad=instalado_medellin]');
  assert.equal(r.modalidadTag, 'instalado_medellin');
  assert.equal(r.modalidadParaResolver, 'instalado');
});

test('extraerTagCotizarRepisa — traduce envio_nacional → enviado', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,modalidad=envio_nacional]');
  assert.equal(r.modalidadParaResolver, 'enviado');
});

test('extraerTagCotizarRepisa — "recogida" pasa sin traducir (resolverPrecioRepisa ya la escala)', function() {
  const r = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,modalidad=recogida]');
  assert.equal(r.modalidadParaResolver, 'recogida');
});

test('extraerTagCotizarRepisa + resolverPrecioRepisa — integración de la traducción de modalidad con datos reales', function() {
  const fs = require('fs');
  const path = require('path');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'precios_repisas_v2.csv'), 'utf8');
  const filas = app.parsearCsvPreciosRepisas(csv).map(function(f) {
    return Object.assign({}, f, { requiere_aprobacion_descuento: app.calcularRequiereAprobacionDescuento(f) });
  });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  const resultado = app.resolverPrecioRepisa(
    { largoCm: tag.largoCm, profundidadCm: tag.profundidadCm, modalidad: tag.modalidadParaResolver },
    filas
  );
  assert.equal(resultado.tipoResolucion, 'exacto');
  assert.equal(resultado.precioFinalSugerido, 280000);
});

test('quitarTagCotizarRepisa — elimina el tag y deja el resto del texto', function() {
  const limpio = app.quitarTagCotizarRepisa('Claro, dame un segundo 😊 [COTIZAR_REPISA:largo=60,prof=20,cantidad=1,modalidad=instalado_medellin]');
  assert.equal(limpio, 'Claro, dame un segundo 😊');
  assert.equal(limpio.indexOf('COTIZAR_REPISA'), -1);
});

test('quitarTagCotizarRepisa — texto sin tag queda igual', function() {
  assert.equal(app.quitarTagCotizarRepisa('Hola 😊'), 'Hola 😊');
});
