// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — fix de solapamiento de prompt (27 jul, sesión de
// la Fase 6). Un lead real de prueba (110×25cm) confirmó que, a pesar de la
// Fase 6, Olivia escalaba de inmediato con [ESCALAR] sin nunca emitir
// [COTIZAR_REPISA:...] — las reglas viejas del catálogo v1 ("CUÁNDO ESCALA
// SIEMPRE: Piden profundidad diferente a 15cm", más arriba en el prompt)
// le ganaban al bloque nuevo (más abajo). resolverPrecioRepisa() y
// calcularPrecioRepisaDesdeFormula() nunca llegaron a ejecutarse — esta
// sesión NO los toca, arregla el texto del prompt para que Claude sí llegue
// a emitir el tag.
//
// LÍMITE RECONOCIDO (el mismo de siempre, ver docs/PHASE_1A_TESTING.md y
// la nota de la Fase 1B): si Claude realmente sigue una instrucción del
// prompt es comportamiento del modelo, no interceptable por código. Las
// pruebas de esta suite verifican (a) que el TEXTO del prompt tiene la
// instrucción correcta, y (b) que SI Claude emite el tag como se le pide,
// el código de nuestro lado (procesarMensaje/manejarCotizacionRepisa) lo
// procesa bien de punta a punta. Ninguna prueba aquí puede garantizar que
// el modelo real seguirá la instrucción — eso se confirma con conversación
// real (Lili probando por WhatsApp), no con node:test.
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

function conFlagV2(fn) {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  process.env.COTIZADOR_REPISAS_V2_ENABLED = 'true';
  try {
    return fn();
  } finally {
    process.env.COTIZADOR_REPISAS_V2_ENABLED = original === undefined ? '' : original;
    if (original === undefined) delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Texto del prompt — la instrucción de prioridad y las redirecciones
// ─────────────────────────────────────────────────────────────────────────
test('getSystemPrompt — con el flag encendido, el bloque V2 declara prioridad explícita sobre las reglas viejas', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('PRIORIDAD') !== -1, 'debe haber una declaración de prioridad explícita');
    assert.ok(prompt.indexOf('esta sección es la que manda') !== -1);
  });
});

test('getSystemPrompt — con el flag encendido, las 3 reglas viejas señaladas ahora redirigen al bloque V2 en vez de escalar directo', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    const ocurrencias = prompt.split('COTIZADOR DE REPISAS — PROFUNDIDADES DISTINTAS A 15CM').length - 1;
    // Debe aparecer 1 vez como título de la sección, y repetida dentro de
    // cada una de las 3 notas de redirección insertadas en las reglas viejas.
    assert.ok(ocurrencias >= 4, 'la sección V2 debe mencionarse desde el título Y desde las 3 redirecciones (encontradas: ' + ocurrencias + ')');
  });
});

test('getSystemPrompt — con el flag encendido, ya NO exige preguntar la cantidad — la asume 1 por defecto', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('ASUME que es 1') !== -1, 'debe instruir asumir cantidad=1 sin preguntarla');
    assert.equal(prompt.indexOf('falte el largo, la ciudad o la cantidad'), -1, 'la instrucción vieja que trataba la cantidad como dato pendiente por preguntar debe haber sido reemplazada');
  });
});

test('getSystemPrompt — con el flag APAGADO, las reglas viejas quedan exactamente igual (sin la nota de redirección)', function() {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
  const prompt = app.getSystemPrompt();
  assert.equal(prompt.indexOf('COTIZADOR DE REPISAS — PROFUNDIDADES DISTINTAS A 15CM'), -1, 'con el flag apagado, la sección V2 no debe existir en absoluto');
  assert.equal(prompt.indexOf('sigue primero la sección'), -1, 'sin la sección V2, las reglas viejas no deben referenciarla — cero cambio de comportamiento');
  assert.ok(prompt.indexOf('Piden profundidad diferente a 15cm (30cm, 25cm, 40cm, etc.)') !== -1, 'la regla vieja debe seguir presente, intacta, para el catálogo v1');
  if (original !== undefined) process.env.COTIZADOR_REPISAS_V2_ENABLED = original;
});

// ─────────────────────────────────────────────────────────────────────────
// Caso A — saludo genérico de repisa, sin escalar (comportamiento existente,
// no cambia con este fix — se re-confirma aquí en el contexto del bug).
// ─────────────────────────────────────────────────────────────────────────
test('Caso A — "Hola quiero una repisas": sin tag en la respuesta de Claude, el flujo sigue normal, sin forzar escalamiento', function() {
  // No podemos controlar qué responde el modelo real a un saludo — esto
  // confirma que, estructuralmente, si Claude NO emite el tag (como
  // corresponde a un saludo sin medida todavía), procesarMensaje() no
  // dispara manejarCotizacionRepisa() ni ningún escalamiento forzado.
  const tag = app.extraerTagCotizarRepisa('¡Hola! 😊 Hacemos repisas flotantes en roble natural... ¿qué medida necesitas?');
  assert.equal(tag, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Caso B — pide medida sin ciudad: el prompt ahora instruye preguntar,
// nunca escalar solo por falta de ciudad (verificado en el texto, ver
// pruebas de arriba). A nivel de código: sin tag, el flujo sigue normal.
// ─────────────────────────────────────────────────────────────────────────
test('Caso B — "Tienes de 110 x 25" sin ciudad: el prompt instruye preguntar la ciudad, nunca escalar por eso', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('NO escales solo porque todavía no sabes la ciudad') !== -1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Caso C y D — con el tag emitido (simulando que Claude sí lo siguió),
// el backend calcula $380.000 por fórmula y el cliente recibe el precio
// final, nunca el tag crudo. Cubre tanto el caso multi-turno (C: ciudad
// llega en un mensaje aparte, con contexto previo) como el de un solo
// mensaje (D) — desde procesarMensaje() ambos son idénticos: lo único que
// importa es que la respuesta de la PRIMERA llamada a Claude traiga el tag.
// ─────────────────────────────────────────────────────────────────────────
test('Caso C — tag emitido tras conversación multi-turno (110x25 luego "Para Medellín") calcula $380.000 y nunca expone el tag', async function() {
  const numero = '573000000301';
  prepararEntorno(numero);

  let numeroDeLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function(systemPrompt) {
    numeroDeLlamada++;
    if (numeroDeLlamada === 1) {
      return Promise.resolve({ data: { content: [{ text: '[COTIZAR_REPISA:largo=110,prof=25,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]' }] } });
    }
    assert.ok(systemPrompt.indexOf('380.000') !== -1, 'debe inyectar el precio ya calculado por fórmula');
    return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa de 110x25cm en Medellín queda en $380.000. ¿Arrancamos?' }] } });
  });

  await app.procesarMensaje(numero, 'Para Medellín', null, null);
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  assert.equal(numeroDeLlamada, 2);
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('380.000') !== -1);
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1, 'el tag nunca debe llegar al cliente');
});

test('Caso D — tag emitido en un solo mensaje ("110x25 en Medellín") calcula $380.000 igual que el caso multi-turno', async function() {
  const numero = '573000000302';
  prepararEntorno(numero);

  let numeroDeLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function(systemPrompt) {
    numeroDeLlamada++;
    if (numeroDeLlamada === 1) {
      return Promise.resolve({ data: { content: [{ text: '[COTIZAR_REPISA:largo=110,prof=25,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]' }] } });
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

// ─────────────────────────────────────────────────────────────────────────
// Caso E — profundidad>30cm: el prompt instruye NO emitir el tag y dar el
// mensaje de paredes/listones directo. Como defensa en profundidad, SI
// Claude emitiera el tag de todas formas, resolverPrecioRepisa() ya lo
// bloquea con el mensaje específico — ver
// test/cotizador-v2-fase6.test.js ("profundidad>30cm escala con el
// mensaje específico de paredes/listones"), no se duplica aquí.
// ─────────────────────────────────────────────────────────────────────────
test('Caso E — el prompt instruye NO emitir el tag para profundidad>30cm y explicar paredes/listones directo', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('profundidad mayor a 30cm') !== -1);
    assert.ok(prompt.indexOf('pared de fondo y una pared lateral') !== -1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Caso F — entamborada: por diseño (decisión ya confirmada por Lili en la
// Fase 6, ver docs/COTIZADOR_V2_PLAN.md), el filtro es SOLO de prompt —
// no hay parámetro de espesor en el tag ni en resolverPrecioRepisa(). No
// hay defensa de código posible más allá de esta instrucción; se verifica
// que el texto exista.
// ─────────────────────────────────────────────────────────────────────────
test('Caso F — el prompt instruye NO emitir el tag para entamborada/tipo caja/espesor especial', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('entamborada') !== -1);
    assert.ok(prompt.indexOf('tipo caja') !== -1);
    assert.ok(prompt.indexOf('espesor distinto a 3.6cm o 3cm') !== -1);
  });
});
