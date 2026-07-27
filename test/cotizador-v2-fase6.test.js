// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — FASE 6 (27 jul): cálculo real por fórmula desde
// los parámetros base del Excel "Parametros" v1/v2, para cualquier
// combinación de largo×profundidad que NO esté en las 66 filas exactas del
// CSV. Reemplaza la interpolación lineal anterior (ver test/cotizador-v2.test.js
// para los dos casos migrados de interpolado→formula).
//
// Los parámetros de la fórmula (umbrales de tamaño, costos de barniz/mano
// de obra/soportes, redondeo) fueron confirmados EXPLÍCITAMENTE por Lili —
// nunca deducidos del CSV (ver docs/COTIZADOR_V2_PLAN.md y el hilo de
// aprobación). Los 3 casos base (110×25, 175×20, 95×30) fueron calculados a
// mano y verificados por Lili antes de escribir este código.
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = process.env.CONTROL_TOKEN || 'token-de-prueba-fase1a';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

const CSV_REAL = fs.readFileSync(path.join(__dirname, '..', 'data', 'precios_repisas_v2.csv'), 'utf8');
const CATALOGO_SEMBRADO = app.parsearCsvPreciosRepisas(CSV_REAL).map(function(f) {
  return Object.assign({}, f, { requiere_aprobacion_descuento: app.calcularRequiereAprobacionDescuento(f) });
});

function prepararEntorno(numero) {
  app.__setPreciosRepisasParaPruebas(CATALOGO_SEMBRADO);
  delete app.conversaciones[numero];
  delete app.pausados[numero];
  app.__setPoolParaPruebas({ query: function() { return Promise.resolve({ rows: [] }); } });
}

function ultimoMensajeGuardado(numero) {
  var conv = app.conversaciones[numero] || [];
  return conv.length > 0 ? conv[conv.length - 1].content : null;
}

// ─────────────────────────────────────────────────────────────────────────
// clasificarTamanoRepisa
// ─────────────────────────────────────────────────────────────────────────
test('clasificarTamanoRepisa — pequeña (ambas dimensiones chicas)', function() {
  assert.equal(app.clasificarTamanoRepisa(50, 15), 'pequena');
  assert.equal(app.clasificarTamanoRepisa(40, 15), 'pequena');
});

test('clasificarTamanoRepisa — mediana (rango por defecto, incluye el límite exacto 120×25)', function() {
  assert.equal(app.clasificarTamanoRepisa(100, 20), 'mediana');
  assert.equal(app.clasificarTamanoRepisa(110, 25), 'mediana');
  assert.equal(app.clasificarTamanoRepisa(120, 25), 'mediana', 'límite exacto — 120 no es >120 y 25 no es >25');
});

test('clasificarTamanoRepisa — grande por largo (121, un cm por encima del límite)', function() {
  assert.equal(app.clasificarTamanoRepisa(121, 25), 'grande');
  assert.equal(app.clasificarTamanoRepisa(175, 20), 'grande');
});

test('clasificarTamanoRepisa — grande/profunda por profundidad (aunque el largo sea chico)', function() {
  assert.equal(app.clasificarTamanoRepisa(95, 30), 'grande');
  assert.equal(app.clasificarTamanoRepisa(120, 30), 'grande');
});

// ─────────────────────────────────────────────────────────────────────────
// calcularPrecioRepisaDesdeFormula — los 3 casos aprobados a mano por Lili
// ─────────────────────────────────────────────────────────────────────────
test('calcularPrecioRepisaDesdeFormula — 110×25 = $380.000 (mediana)', function() {
  const r = app.calcularPrecioRepisaDesdeFormula(110, 25);
  assert.equal(r.tamano, 'mediana');
  assert.equal(r.barniz, 10000);
  assert.equal(r.manoObra, 20000);
  assert.equal(r.soportes, 30000, '3 soportes (90-140cm) × $10.000 (soporte 25cm, prof 25)');
  assert.equal(r.precioComercial, 380000);
});

test('calcularPrecioRepisaDesdeFormula — 175×20 = $460.000 (grande por largo)', function() {
  const r = app.calcularPrecioRepisaDesdeFormula(175, 20);
  assert.equal(r.tamano, 'grande');
  assert.equal(r.barniz, 15000);
  assert.equal(r.manoObra, 35000);
  assert.equal(r.soportes, 28000, '4 soportes (150-200cm) × $7.000 (soporte 18cm, prof 20)');
  assert.equal(r.precioComercial, 460000);
});

test('calcularPrecioRepisaDesdeFormula — 95×30 = $420.000 (grande/profunda, límite superior permitido)', function() {
  const r = app.calcularPrecioRepisaDesdeFormula(95, 30);
  assert.equal(r.tamano, 'grande');
  assert.equal(r.barniz, 15000);
  assert.equal(r.manoObra, 35000);
  assert.equal(r.soportes, 30000, '3 soportes (90-140cm) × $10.000 (soporte 25cm, prof 30)');
  assert.equal(r.precioComercial, 420000);
});

test('calcularPrecioRepisaDesdeFormula — redondeo hacia arriba explícito (Math.ceil, nunca Math.round)', function() {
  // 50×15: valor técnico ≈ $207.529,82 — Math.round daría 210.000 igual
  // (está más cerca de 210k), así que se verifica con un caso donde
  // round() y ceil() darían resultados DISTINTOS si el valor técnico
  // hubiera quedado justo por debajo de la mitad de la decena de mil.
  // 120×25: valor técnico ≈ $392.031,92 → round() también da 390.000
  // (más cerca de 390k que de 400k), pero ceil() debe dar 400.000 —
  // esta es la prueba real de que se usa ceil y no round.
  const r = app.calcularPrecioRepisaDesdeFormula(120, 25);
  assert.equal(r.precioComercial, 400000, 'ceil(392.031,92/10.000)*10.000 = 400.000 — con Math.round hubiera dado 390.000');
});

// ─────────────────────────────────────────────────────────────────────────
// resolverPrecioRepisa — integración completa vía fórmula
// ─────────────────────────────────────────────────────────────────────────
test('resolverPrecioRepisa — 110×25 instalado → formula, $380.000', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 110, profundidadCm: 25, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'formula');
  assert.equal(r.precioFinalSugerido, 380000);
  assert.equal(r.permiteDescuentoAutomatico, false);
});

test('resolverPrecioRepisa — 175×20 instalado → formula, $460.000', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 175, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'formula');
  assert.equal(r.precioFinalSugerido, 460000);
});

test('resolverPrecioRepisa — 95×30 instalado → formula, $420.000 (límite superior de profundidad automática)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 95, profundidadCm: 30, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'formula');
  assert.equal(r.precioFinalSugerido, 420000);
});

test('resolverPrecioRepisa — 95×31 → requiere_aprobacion CON mensaje específico de paredes/listones, no genérico', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 95, profundidadCm: 31, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
  assert.ok(r.alerta.indexOf('listones') !== -1, 'la alerta interna debe mencionar listones');
  assert.ok(r.mensajeParaCliente, 'debe traer un mensaje específico para el cliente');
  assert.ok(r.mensajeParaCliente.indexOf('listones') !== -1, 'el mensaje al cliente debe explicar el cambio de sistema de instalación, no ser genérico');
  assert.notEqual(r.mensajeParaCliente, 'Esa medida es más personalizada. Déjame confirmarla con Lili para darte el valor exacto 😊');
});

test('resolverPrecioRepisa — 201×20 → requiere_aprobacion (largo mayor al máximo automático de 200cm)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 201, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
});

test('resolverPrecioRepisa — 19×15 → requiere_aprobacion (largo menor al mínimo automático de 20cm)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 19, profundidadCm: 15, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
});

test('resolverPrecioRepisa — 95×28 → requiere_aprobacion (profundidad intermedia no modelada, ni interpola ni extrapola)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 95, profundidadCm: 28, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
});

test('resolverPrecioRepisa — envío nacional sin fila exacta → requiere_aprobacion (fórmula no cubre envío todavía)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 63, profundidadCm: 20, modalidad: 'enviado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion', 'no inventar costo de envío nacional dentro de la fórmula, por ahora');
});

test('resolverPrecioRepisa — modalidad recogida → requiere_aprobacion incluso en una medida que sí sería elegible por fórmula', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 63, profundidadCm: 20, modalidad: 'recogida' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
});

test('resolverPrecioRepisa — coincidencia exacta en las 66 filas sigue teniendo prioridad sobre la fórmula', function() {
  // 60×20 existe como fila exacta (comercial_instalado=280.000) Y también
  // cumpliría las condiciones de elegibilidad de la fórmula si no existiera
  // la fila — debe ganar la fila exacta, no recalcularse.
  const r = app.resolverPrecioRepisa({ largoCm: 60, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'exacto');
  assert.equal(r.precioFinalSugerido, 280000);
});

// ─────────────────────────────────────────────────────────────────────────
// manejarCotizacionRepisa — el mensaje específico de paredes/listones llega
// realmente al cliente (no solo vive en resolverPrecioRepisa)
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — profundidad>30cm escala con el mensaje específico de paredes/listones', async function() {
  const numero = '573000000201';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() { llamadasSegundaLlamada++; return Promise.resolve({ data: { content: [{ text: 'no debería llegar aquí' }] } }); });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=35,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'quiero 35cm de profundidad', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 0, 'nunca debe intentar calcular ni redactar con precio para este caso');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('listones') !== -1, 'el mensaje real guardado/enviado debe mencionar listones, no ser el genérico');
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1);
  assert.equal(app.pausados[numero], true);
  assert.equal(app.procesando[numero], undefined);
});

test('manejarCotizacionRepisa — 110×25 (caso aprobado) calcula por fórmula y redacta con $380.000', async function() {
  const numero = '573000000202';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function(systemPrompt) {
    llamadasSegundaLlamada++;
    assert.ok(systemPrompt.indexOf('380.000') !== -1, 'debe inyectar el precio calculado por fórmula, no un precio interpolado ni distinto');
    return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa de 110cm en 25cm de profundidad queda en $380.000. ¿Arrancamos?' }] } });
  });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=110,prof=25,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'quiero 110x25', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 1);
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('380.000') !== -1);
  assert.equal(app.pausados[numero], undefined, 'un cálculo exitoso por fórmula tampoco debe pausar al lead');
});

// ─────────────────────────────────────────────────────────────────────────
// getSystemPrompt — guardas de espesor/entamborada, solo con el flag encendido
// ─────────────────────────────────────────────────────────────────────────
test('getSystemPrompt — con el flag encendido, instruye NO cotizar espesores distintos a 3.6/3cm ni entamboradas/tipo caja', function() {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  process.env.COTIZADOR_REPISAS_V2_ENABLED = 'true';
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('espesor distinto a 3.6cm o 3cm') !== -1, 'debe instruir no cotizar espesores fuera de lo estándar');
  assert.ok(prompt.indexOf('entamborada') !== -1);
  assert.ok(prompt.indexOf('tipo caja') !== -1);
  assert.ok(prompt.indexOf('profundidad mayor a 30cm') !== -1, 'debe instruir no cotizar automático más de 30cm, aunque resolverPrecioRepisa() ya lo bloquea como segunda capa');
  process.env.COTIZADOR_REPISAS_V2_ENABLED = original === undefined ? '' : original;
  if (original === undefined) delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
});
