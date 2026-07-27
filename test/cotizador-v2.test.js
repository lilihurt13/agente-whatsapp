// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — siembra idempotente, cálculo de
// requiere_aprobacion_descuento, y resolverPrecioRepisa() (función pura,
// probada con datos REALES de data/precios_repisas_v2.csv, no con
// ejemplos inventados).
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = process.env.CONTROL_TOKEN || 'token-de-prueba-fase1a';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearPoolSimulado } = require('./helpers/fakePool');
const app = require('../whatsapp_agent.js');

const CSV_REAL = fs.readFileSync(path.join(__dirname, '..', 'data', 'precios_repisas_v2.csv'), 'utf8');
const FILAS_REALES = app.parsearCsvPreciosRepisas(CSV_REAL);

// Igual que quedarían cargadas desde la BD tras sembrarPreciosRepisas()
// (que sí calcula y guarda requiere_aprobacion_descuento) — FILAS_REALES
// por sí solas son el CSV crudo, sin ese campo calculado.
const CATALOGO_SEMBRADO = FILAS_REALES.map(function(f) {
  return Object.assign({}, f, { requiere_aprobacion_descuento: app.calcularRequiereAprobacionDescuento(f) });
});

function poolFresco() {
  const p = crearPoolSimulado();
  app.__setPoolParaPruebas(p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Parseo del CSV real
// ─────────────────────────────────────────────────────────────────────────
test('parsearCsvPreciosRepisas — parsea las 66 filas reales sin NaN', function() {
  assert.equal(FILAS_REALES.length, 66);
  const conNaN = FILAS_REALES.filter(function(f) {
    return Object.keys(f).some(function(k) { return typeof f[k] === 'number' && isNaN(f[k]); });
  });
  assert.equal(conNaN.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// calcularRequiereAprobacionDescuento
// ─────────────────────────────────────────────────────────────────────────
test('calcularRequiereAprobacionDescuento — true por alerta explícita', function() {
  const fila = FILAS_REALES.find(function(f) { return f.prof_cm === 10 && f.largo_cm === 20; });
  assert.equal(app.calcularRequiereAprobacionDescuento(fila), true);
});

test('calcularRequiereAprobacionDescuento — true por "pequeña profunda" (25/30cm, largo<50)', function() {
  const fila = FILAS_REALES.find(function(f) { return f.prof_cm === 25 && f.largo_cm === 30; });
  assert.equal(app.calcularRequiereAprobacionDescuento(fila), true);
});

test('calcularRequiereAprobacionDescuento — false cuando no aplica ninguna condición', function() {
  const fila = FILAS_REALES.find(function(f) { return f.prof_cm === 10 && f.largo_cm === 50; });
  assert.equal(fila.alerta, '');
  assert.equal(app.calcularRequiereAprobacionDescuento(fila), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Siembra idempotente (contra el pool simulado)
// ─────────────────────────────────────────────────────────────────────────
test('sembrarPreciosRepisas — siembra las 66 filas y correrlo dos veces no duplica', async function() {
  const pool = poolFresco();
  await app.sembrarPreciosRepisas();
  assert.equal(pool._estado.preciosRepisas.length, 66, 'primera siembra: 66 filas');

  await app.sembrarPreciosRepisas();
  assert.equal(pool._estado.preciosRepisas.length, 66, 'segunda siembra: sigue en 66, no duplica');
});

// ─────────────────────────────────────────────────────────────────────────
// resolverPrecioRepisa — con datos REALES del CSV
// ─────────────────────────────────────────────────────────────────────────
test('resolverPrecioRepisa — coincidencia exacta (20x60, permite descuento)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 60, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'exacto');
  assert.equal(r.precioFinalSugerido, 280000);
  assert.equal(r.permiteDescuentoAutomatico, true);
});

test('resolverPrecioRepisa — 🆕 FASE 6: medida sin fila exacta (20x63) ya NO interpola, calcula por fórmula', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 63, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'formula');
  assert.equal(r.precioFinalSugerido, 260000);
  assert.equal(r.permiteDescuentoAutomatico, false, 'un precio calculado por fórmula nunca habilita descuento automático');
});

test('resolverPrecioRepisa — coincidencia exacta con requiere_aprobacion_descuento=true rechaza el descuento (25x30)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 30, profundidadCm: 25, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'exacto');
  assert.equal(r.permiteDescuentoAutomatico, false);
});

test('resolverPrecioRepisa — modo envío nacional usa comercial_enviado directo, sin restar nada extra (20x60)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 60, profundidadCm: 20, modalidad: 'enviado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'exacto');
  assert.equal(r.precioFinalSugerido, 250000, 'debe ser exactamente comercial_enviado, sin descontar transporte/buffer');
});

test('resolverPrecioRepisa — 🆕 FASE 6: medida sin fila exacta (10x26) calcula por fórmula, no aplica piso de mínimo aprobado (ya no existe ese concepto en fórmula)', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 26, profundidadCm: 10, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'formula');
  assert.equal(r.precioFinalSugerido, 170000);
});

test('resolverPrecioRepisa — sin dos referencias en esa profundidad: requiere aprobación, nunca extrapola', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 500, profundidadCm: 20, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
  assert.equal(r.precioFinalSugerido, null);
});

test('resolverPrecioRepisa — profundidad inexistente en el catálogo: requiere aprobación', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 60, profundidadCm: 45, modalidad: 'instalado' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
});

test('resolverPrecioRepisa — modalidad "recoge" (Modo 3) siempre requiere aprobación, sin calcular', function() {
  const r = app.resolverPrecioRepisa({ largoCm: 60, profundidadCm: 20, modalidad: 'recoge' }, CATALOGO_SEMBRADO);
  assert.equal(r.tipoResolucion, 'requiere_aprobacion');
  assert.equal(r.precioFinalSugerido, null);
});

// ─────────────────────────────────────────────────────────────────────────
// construirCatalogoRepisasV2 — sanity
// ─────────────────────────────────────────────────────────────────────────
test('construirCatalogoRepisasV2 — agrupa por profundidad y muestra solo comercial_instalado', function() {
  app.__setPreciosRepisasParaPruebas(CATALOGO_SEMBRADO);
  const texto = app.construirCatalogoRepisasV2();
  assert.ok(texto.indexOf('Profundidad 10cm') !== -1);
  assert.ok(texto.indexOf('Profundidad 30cm') !== -1);
  assert.ok(texto.indexOf('60cm') !== -1);
  app.__setPreciosRepisasParaPruebas([]); // limpiar para no afectar otras pruebas
});
