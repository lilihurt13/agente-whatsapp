// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — FASE 5: interceptar el tag [COTIZAR_REPISA:...],
// segunda llamada a Claude con el precio ya resuelto, y ruta única de
// escalamiento seguro ante cualquier falla. Cubre los casos pedidos por
// Lili: sin datos/parcial (ver Fase 3, extraerTagCotizarRepisa), datos
// completos, cantidad>1, medida fuera de rango, modalidad recogida, tag
// malformado, y confirmación explícita de que el tag nunca sale al
// cliente (nunca queda en conversaciones/messages, que es lo que
// realmente se envía).
//
// LÍMITE RECONOCIDO: estas pruebas NO llaman a notificarLili() ni a
// enviarMensaje() de forma aislada — ambas siguen siendo las funciones
// reales (notificarLili por regla explícita de Lili: "no tocar
// notificarLili()"; enviarMensaje por consistencia con esa misma regla).
// Como consecuencia, cada escenario de escalamiento hace UN intento real
// de red hacia Telegram/Meta con credenciales falsas de prueba — falla
// rápido y queda atrapado por el propio try/catch interno de esas
// funciones (mismo patrón ya usado en toda la suite para pool/axios no
// mockeados). Lo que SÍ se verifica con certeza en cada caso es qué queda
// guardado en `conversaciones` — que es exactamente el texto que
// `enviarMensaje()` recibió como argumento, por invariante del código
// (agregarMensaje y enviarMensaje siempre reciben el mismo texto en
// manejarCotizacionRepisa/escalarCotizacionSinPrecio).
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
// Caso: datos completos, cantidad=1 → cálculo automático exitoso
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — datos completos y elegibles: calcula, redacta, guarda y limpia procesando', async function() {
  const numero = '573000000101';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function(systemPrompt, mensajes) {
    llamadasSegundaLlamada++;
    assert.ok(systemPrompt.indexOf('PRECIO YA CALCULADO POR EL SISTEMA') !== -1, 'el system prompt de la segunda llamada debe traer el precio inyectado');
    assert.ok(systemPrompt.indexOf('$280.000') !== -1 || systemPrompt.indexOf('280.000') !== -1, 'debe incluir el precio exacto resuelto (20x60 = 280.000)');
    return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Con roble natural, herrajes invisibles, tu repisa de 60cm en profundidad 20 queda en $280.000. ¿Arrancamos?' }] } });
  });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'texto original del cliente', tag, 'SYSTEM PROMPT BASE', [{ role: 'user', content: 'hola' }]);

  assert.equal(llamadasSegundaLlamada, 1, 'debe hacer exactamente una segunda llamada a Claude');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado, 'debe guardar algo en conversaciones');
  assert.ok(guardado.indexOf('280.000') !== -1, 'debe guardar el mensaje redactado con el precio');
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1, 'el tag NUNCA debe quedar en lo guardado (= lo que se envía al cliente)');
  assert.equal(app.pausados[numero], undefined, 'un cálculo exitoso no debe pausar al lead');
  assert.equal(app.procesando[numero], undefined, 'procesando[from] debe quedar limpio');
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: cantidad > 1 → escala sin calcular, sin segunda llamada
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — cantidad>1 escala sin calcular y sin segunda llamada a Claude', async function() {
  const numero = '573000000102';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() { llamadasSegundaLlamada++; return Promise.resolve({ data: { content: [{ text: 'no debería llegar aquí' }] } }); });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=20,cantidad=3,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'quiero 3 repisas iguales', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 0, 'NUNCA debe intentar la segunda llamada si cantidad>1');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('Lili') !== -1, 'debe guardar el mensaje de escalamiento mencionando a Lili');
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1);
  assert.equal(app.pausados[numero], true, 'debe pausar al lead para que Lili confirme manualmente');
  assert.equal(app.procesando[numero], undefined, 'procesando[from] debe quedar limpio también en el camino de escalamiento');
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: medida fuera de rango (sin dos referencias en esa profundidad)
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — medida fuera de rango escala sin calcular', async function() {
  const numero = '573000000103';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() { llamadasSegundaLlamada++; return Promise.resolve({ data: { content: [{ text: 'no debería llegar aquí' }] } }); });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=500,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'quiero una de 500cm', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 0);
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('Lili') !== -1);
  assert.equal(app.pausados[numero], true);
  assert.equal(app.procesando[numero], undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: modalidad "recogida" — resolverPrecioRepisa la rechaza (segunda capa)
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — modalidad recogida escala vía resolverPrecioRepisa (segunda capa de defensa)', async function() {
  const numero = '573000000104';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() { llamadasSegundaLlamada++; return Promise.resolve({ data: { content: [{ text: 'no debería llegar aquí' }] } }); });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=20,cantidad=1,modalidad=recogida]');
  assert.equal(tag.elegibleParaCalculoAutomatico, true, 'el parser SÍ la marca elegible por cantidad — la protección real es de resolverPrecioRepisa()');

  await app.manejarCotizacionRepisa(numero, 'yo la recojo', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 0);
  assert.equal(app.pausados[numero], true);
  assert.equal(app.procesando[numero], undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: la segunda llamada a Claude falla → escalamiento seguro, sin reintento
// ─────────────────────────────────────────────────────────────────────────
test('manejarCotizacionRepisa — si la segunda llamada falla, escala en vez de dejar al cliente sin respuesta', async function() {
  const numero = '573000000105';
  prepararEntorno(numero);
  app.procesando[numero] = true;

  let llamadasSegundaLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function() {
    llamadasSegundaLlamada++;
    return Promise.reject(new Error('timeout simulado de la API de Anthropic'));
  });

  const tag = app.extraerTagCotizarRepisa('[COTIZAR_REPISA:largo=60,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]');
  await app.manejarCotizacionRepisa(numero, 'texto original', tag, 'SYSTEM PROMPT BASE', []);

  assert.equal(llamadasSegundaLlamada, 1, 'se intenta una sola vez — sin reintento, decisión de Lili');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado, 'el cliente NUNCA se queda sin respuesta guardada');
  assert.ok(guardado.indexOf('Lili') !== -1);
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1);
  assert.equal(app.pausados[numero], true);
  assert.equal(app.procesando[numero], undefined, 'procesando[from] se limpia incluso cuando la segunda llamada falla');
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: tag ausente en la respuesta de Claude → flujo normal, sin cotizador
// ─────────────────────────────────────────────────────────────────────────
test('extraerTagCotizarRepisa — respuesta normal de Claude sin tag no dispara nada del cotizador', function() {
  const tag = app.extraerTagCotizarRepisa('¡Hola! 😊 ¿Qué tipo de mueble te interesa?');
  assert.equal(tag, null, 'sin tag, procesarMensaje() sigue su flujo normal (agregarMensaje con la respuesta tal cual, sin pasar por manejarCotizacionRepisa)');
});

// ─────────────────────────────────────────────────────────────────────────
// Caso: tag malformado → tratado igual que "sin tag" (extraerTagCotizarRepisa ya lo cubre en la Fase 3, se re-confirma aquí en el contexto de la Fase 5)
// ─────────────────────────────────────────────────────────────────────────
test('extraerTagCotizarRepisa — tag malformado (sin profundidad) no dispara el cotizador', function() {
  const tag = app.extraerTagCotizarRepisa('Un momento... [COTIZAR_REPISA:largo=60,cantidad=1,modalidad=instalado_medellin]');
  assert.equal(tag, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Integración end-to-end: procesarMensaje() detecta el tag en la respuesta
// de la PRIMERA llamada y enruta correctamente a manejarCotizacionRepisa(),
// sin que la respuesta cruda (con el tag) pase nunca por agregarMensaje().
// ─────────────────────────────────────────────────────────────────────────
test('procesarMensaje — intercepta el tag de la primera llamada y nunca guarda la respuesta cruda con el tag', async function(t) {
  const numero = '573000000106';
  prepararEntorno(numero);

  let numeroDeLlamada = 0;
  app.__setLlamarClaudeParaPruebas(function(systemPrompt, mensajes) {
    numeroDeLlamada++;
    if (numeroDeLlamada === 1) {
      // Primera llamada: Claude "decide" cotizar y emite el tag.
      return Promise.resolve({ data: { content: [{ text: '[COTIZAR_REPISA:largo=60,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]' }] } });
    }
    // Segunda llamada: la redacción final, ya con el precio inyectado.
    assert.ok(systemPrompt.indexOf('PRECIO YA CALCULADO POR EL SISTEMA') !== -1);
    return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa queda en $280.000. ¿Arrancamos?' }] } });
  });

  await app.procesarMensaje(numero, 'quiero una repisa de 60x20', null, null);
  // procesarMensaje agenda internamente el reintento/otros pasos con
  // setTimeout(500) en otras ramas, pero la llamada a Claude y el manejo
  // del tag ocurren de forma síncrona dentro de las promesas ya resueltas
  // — esperamos un tick extra para dejar correr el .then() encadenado.
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  assert.equal(numeroDeLlamada, 2, 'debe haber exactamente 2 llamadas a Claude: la que emite el tag, y la que redacta el mensaje final');
  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado, 'debe quedar guardado el mensaje final');
  assert.ok(guardado.indexOf('280.000') !== -1);
  assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1, 'la respuesta cruda con el tag de la PRIMERA llamada nunca debe quedar guardada');

  // Confirmar que en NINGÚN punto del historial completo del número quedó el tag.
  const conv = app.conversaciones[numero] || [];
  const algunoConTag = conv.some(function(m) { return typeof m.content === 'string' && m.content.indexOf('COTIZAR_REPISA') !== -1; });
  assert.equal(algunoConTag, false, 'el tag no debe aparecer en ningún mensaje del historial completo');
});

// ─────────────────────────────────────────────────────────────────────────
// Feature flag COTIZADOR_REPISAS_V2_ENABLED — apagado por defecto, cero
// cambio de comportamiento hasta que se active explícitamente.
// ─────────────────────────────────────────────────────────────────────────
test('cotizadorRepisasV2Habilitado — false por defecto (variable ausente)', function() {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
  assert.equal(app.cotizadorRepisasV2Habilitado(), false);
  if (original !== undefined) process.env.COTIZADOR_REPISAS_V2_ENABLED = original;
});

test('getSystemPrompt — con el flag apagado, el prompt NO menciona el tag del cotizador', function() {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
  const prompt = app.getSystemPrompt();
  assert.equal(prompt.indexOf('COTIZAR_REPISA'), -1, 'con el flag apagado, Olivia nunca ve la instrucción del tag');
  if (original !== undefined) process.env.COTIZADOR_REPISAS_V2_ENABLED = original;
});

test('getSystemPrompt — con el flag encendido, el prompt SÍ incluye la instrucción del tag', function() {
  const original = process.env.COTIZADOR_REPISAS_V2_ENABLED;
  process.env.COTIZADOR_REPISAS_V2_ENABLED = 'true';
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('[COTIZAR_REPISA:largo=') !== -1, 'con el flag encendido, la instrucción del tag debe estar presente');
  assert.ok(prompt.indexOf('NUNCA lo muestres junto con otro texto') !== -1);
  process.env.COTIZADOR_REPISAS_V2_ENABLED = original === undefined ? '' : original;
  if (original === undefined) delete process.env.COTIZADOR_REPISAS_V2_ENABLED;
});
