// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — FASE 7 (27 jul): capa determinística de
// respaldo. Confirmado con 3 pruebas reales consecutivas (historial
// limpio, historial con continuidad) que Claude puede CONSERVAR el
// contexto de la medida pero aun así elegir escalar en lenguaje natural en
// vez de emitir [COTIZAR_REPISA:...] — no es un problema de memoria ni de
// prompt (ya reforzado 3 veces en esta sesión). Esta capa detecta la
// cotización segura desde el historial SIN depender de que Claude coopere,
// y anula un [ESCALAR] de Claude cuando el sistema puede resolver el
// precio con seguridad.
//
// No toca resolverPrecioRepisa(), la fórmula, ni el CSV — solo extrae
// parámetros; el cálculo lo sigue haciendo exclusivamente
// resolverPrecioRepisa() (ver test/cotizador-v2-fase6.test.js).
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

// async: debe esperar a que fn() (que puede ser async) termine ANTES de
// restaurar el flag — si no, con pruebas async el `finally` corre de
// inmediato (fn() apenas devuelve una promesa pendiente) y el flag ya
// está apagado cuando el resto de la prueba realmente se ejecuta.
async function conFlagV2(fn) {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  process.env.COTIZADOR_REPISAS_V2_ENABLED = 'true';
  try {
    return await fn();
  } finally {
    process.env.COTIZADOR_REPISAS_V2_ENABLED = original === undefined ? '' : original;
    if (original === undefined) delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
  }
}

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
// detectarCotizacionRepisaDesdeContexto — función pura, los 8 casos pedidos
// ─────────────────────────────────────────────────────────────────────────

// Caso 1
test('detectarCotizacionRepisaDesdeContexto — 110x25 en historial + "Medellín" actual → devuelve params completos', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [
      { role: 'user', content: 'Tienes de 110 x 25 cm' },
      { role: 'assistant', content: '¿De dónde eres?' }
    ]
  });
  assert.deepEqual(r, {
    largoCm: 110, profundidadCm: 25, cantidad: 1,
    ciudad: 'Medellín', modalidad: 'instalado_medellin', fuente: 'contexto_reciente'
  });
});

// Caso 3 (mensaje único, sin historial previo)
test('detectarCotizacionRepisaDesdeContexto — mensaje único "Quiero una repisa de 110 x 25 en Medellín" → devuelve params completos', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Quiero una repisa de 110 x 25 en Medellín',
    historialReciente: []
  });
  assert.equal(r.largoCm, 110);
  assert.equal(r.profundidadCm, 25);
  assert.equal(r.ciudad, 'Medellín');
  assert.equal(r.modalidad, 'instalado_medellin');
});

// Caso 4 (Cali — envío nacional, la función SÍ detecta los datos; es
// resolverPrecioRepisa() quien decide requiere_aprobacion por no tener
// fila exacta — ver la prueba end-to-end más abajo)
test('detectarCotizacionRepisaDesdeContexto — 110x25 en historial + "Cali" actual → detecta con modalidad envio_nacional', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Cali',
    historialReciente: [{ role: 'user', content: 'Tienes de 110 x 25 cm' }]
  });
  assert.equal(r.ciudad, 'Cali');
  assert.equal(r.modalidad, 'envio_nacional');
});

// Caso 5
test('detectarCotizacionRepisaDesdeContexto — 110x35 (profundidad>30) + "Medellín" → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [{ role: 'user', content: 'Tienes de 110 x 35 cm' }]
  });
  assert.equal(r, null);
});

// Caso 6
test('detectarCotizacionRepisaDesdeContexto — repisa entamborada + "Medellín" → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [{ role: 'user', content: 'Quiero una repisa entamborada de 110 x 25' }]
  });
  assert.equal(r, null);
});

// Caso 7
test('detectarCotizacionRepisaDesdeContexto — "5 cm de gruesa" + "Medellín" → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [{ role: 'user', content: 'Quiero una repisa de 5 cm de gruesa 110 x 25' }]
  });
  assert.equal(r, null);
});

// Caso 8
test('detectarCotizacionRepisaDesdeContexto — 110x28 (profundidad intermedia no modelada) + "Medellín" → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [{ role: 'user', content: 'Tienes de 110 x 28 cm' }]
  });
  assert.equal(r, null);
});

test('detectarCotizacionRepisaDesdeContexto — sin medida en ningún mensaje → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({ mensajeActual: 'Medellín', historialReciente: [] });
  assert.equal(r, null);
});

test('detectarCotizacionRepisaDesdeContexto — medida sin ciudad en ningún lado → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'sí, esa medida está bien',
    historialReciente: [{ role: 'user', content: 'Tienes de 110 x 25 cm' }]
  });
  assert.equal(r, null);
});

test('detectarCotizacionRepisaDesdeContexto — largo fuera de rango (500x25) → null', function() {
  const r = app.detectarCotizacionRepisaDesdeContexto({
    mensajeActual: 'Medellín',
    historialReciente: [{ role: 'user', content: 'Tienes de 500 x 25 cm' }]
  });
  assert.equal(r, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Integración end-to-end vía procesarMensaje() — Caso 2 y 3
// ─────────────────────────────────────────────────────────────────────────

test('Caso 2 — Claude responde [ESCALAR] pero hay cotización segura por contexto: el backend intercepta y cotiza $380.000, no escala', async function() {
  await conFlagV2(async function() {
    const numero = '573000000501';
    prepararEntorno(numero);
    app.conversaciones[numero] = [
      { role: 'user', content: 'Tienes de 110 x 25 cm', ts: Date.now() - 5000 },
      { role: 'assistant', content: 'Claro 😊 ¿Es para Medellín o para otra ciudad?', ts: Date.now() - 4000 }
    ];

    let numeroDeLlamada = 0;
    app.__setLlamarClaudeParaPruebas(function(systemPrompt) {
      numeroDeLlamada++;
      if (numeroDeLlamada === 1) {
        // Claude "conserva" el contexto pero decide escalar de todas formas, SIN emitir el tag.
        return Promise.resolve({ data: { content: [{ text: 'Perfecto, la de 110cm con 25cm de profundidad. Ya le aviso a Lili para que te confirme el valor exacto 😊 [ESCALAR]' }] } });
      }
      assert.ok(systemPrompt.indexOf('380.000') !== -1, 'la segunda llamada (dentro de manejarCotizacionRepisa) debe traer el precio calculado');
      return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa de 110x25cm en Medellín queda en $380.000. ¿Arrancamos?' }] } });
    });

    await app.procesarMensaje(numero, 'Medellín', null, null);
    await new Promise(function(resolve) { setImmediate(resolve); });
    await new Promise(function(resolve) { setImmediate(resolve); });

    assert.equal(numeroDeLlamada, 2, 'debe llegar a la segunda llamada con el precio, nunca quedarse en el [ESCALAR] de la primera');
    const guardado = ultimoMensajeGuardado(numero);
    assert.ok(guardado.indexOf('380.000') !== -1, 'el cliente debe recibir el precio final, no el mensaje de escalamiento de Claude');
    assert.equal(guardado.indexOf('ESCALAR'), -1);
    assert.equal(guardado.indexOf('Ya le aviso a Lili'), -1, 'el texto de escalamiento original de Claude nunca debe llegar al cliente');
    assert.equal(app.pausados[numero], undefined, 'una cotización resuelta con éxito no debe pausar al lead');
  });
});

test('Caso 3 — mensaje único con todos los datos: Claude escala sin tag, el backend detecta e igual cotiza $380.000', async function() {
  await conFlagV2(async function() {
    const numero = '573000000502';
    prepararEntorno(numero);
    app.conversaciones[numero] = [
      { role: 'user', content: 'Quiero una repisa de 110 x 25 en Medellín', ts: Date.now() }
    ];

    let numeroDeLlamada = 0;
    app.__setLlamarClaudeParaPruebas(function(systemPrompt) {
      numeroDeLlamada++;
      if (numeroDeLlamada === 1) {
        return Promise.resolve({ data: { content: [{ text: 'Esa medida la fabricamos con gusto 😊 Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]' }] } });
      }
      assert.ok(systemPrompt.indexOf('380.000') !== -1);
      return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa de 110x25cm en Medellín queda en $380.000. ¿Arrancamos?' }] } });
    });

    await app.procesarMensaje(numero, 'Quiero una repisa de 110 x 25 en Medellín', null, null);
    await new Promise(function(resolve) { setImmediate(resolve); });
    await new Promise(function(resolve) { setImmediate(resolve); });

    assert.equal(numeroDeLlamada, 2);
    const guardado = ultimoMensajeGuardado(numero);
    assert.ok(guardado.indexOf('380.000') !== -1);
  });
});

test('Caso 4 (end-to-end) — Cali sin fila exacta: el backend detecta contexto pero resolverPrecioRepisa() exige aprobación, se respeta el escalamiento (sin inventar envío)', async function() {
  await conFlagV2(async function() {
    const numero = '573000000503';
    prepararEntorno(numero);
    app.conversaciones[numero] = [
      { role: 'user', content: 'Tienes de 110 x 25 cm', ts: Date.now() - 5000 },
      { role: 'assistant', content: 'Claro 😊 ¿Es para Medellín o para otra ciudad?', ts: Date.now() - 4000 }
    ];

    let numeroDeLlamada = 0;
    app.__setLlamarClaudeParaPruebas(function() {
      numeroDeLlamada++;
      return Promise.resolve({ data: { content: [{ text: 'Perfecto, la de 110x25cm. Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]' }] } });
    });

    await app.procesarMensaje(numero, 'Cali', null, null);
    await new Promise(function(resolve) { setImmediate(resolve); });
    await new Promise(function(resolve) { setImmediate(resolve); });

    assert.equal(numeroDeLlamada, 1, 'sin fila exacta para envío nacional, no debe haber segunda llamada con precio — debe escalar');
    assert.equal(app.pausados[numero], true, 'debe quedar pausado para que Lili confirme el envío manualmente');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Invariante de flag — con el flag apagado, la capa determinística no actúa
// ─────────────────────────────────────────────────────────────────────────
test('Con el flag APAGADO, la capa determinística nunca se activa aunque Claude escale sin tag', async function() {
  const numero = '573000000504';
  prepararEntorno(numero);
  app.conversaciones[numero] = [
    { role: 'user', content: 'Tienes de 110 x 25 cm', ts: Date.now() - 5000 },
    { role: 'assistant', content: 'Claro 😊 ¿Es para Medellín o para otra ciudad?', ts: Date.now() - 4000 }
  ];

  let numeroDeLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() {
    numeroDeLlamada++;
    return Promise.resolve({ data: { content: [{ text: 'Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]' }] } });
  });

  await app.procesarMensaje(numero, 'Medellín', null, null);
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  assert.equal(numeroDeLlamada, 1, 'con el flag apagado, nunca debe intentar una segunda llamada (no hay capa determinística)');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('380.000') === -1, 'no debe cotizar automático con el flag apagado');
  assert.equal(app.pausados[numero], true, 'debe respetar el escalamiento de Claude tal cual, como siempre');
});
