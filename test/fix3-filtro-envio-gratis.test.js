// ═══════════════════════════════════════════════════════════════════════════
// FIX 3 (29 jul) — filtro determinístico de "envío gratis/incluido" no
// aprobado. Complementa FIX 1/FIX 2 (ver test/fix-catalogo-mesa-envio.test.js,
// que solo verifica el TEXTO del prompt). Este filtro es la capa de código
// que corre sobre la RESPUESTA REAL de Claude antes de enviarla al cliente
// — no depende de que Claude siga la instrucción del prompt al pie de la
// letra. Mensaje de reemplazo SIEMPRE fijo (nunca una segunda llamada a
// Claude — ver whatsapp_agent.js, comentario junto a la función).
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = process.env.CONTROL_TOKEN || 'token-de-prueba-fase1a';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

function prepararEntorno(numero) {
  delete app.conversaciones[numero];
  delete app.pausados[numero];
  app.__setPoolParaPruebas({ query: function() { return Promise.resolve({ rows: [] }); } });
}

function ultimoMensajeGuardado(numero) {
  var conv = app.conversaciones[numero] || [];
  return conv.length > 0 ? conv[conv.length - 1].content : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Casos que SÍ deben bloquear (función pura, sin pasar por procesarMensaje)
// ─────────────────────────────────────────────────────────────────────────
test('Bloquea — "el envío es gratis" para Mesa Auxiliar', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('¡Claro! El envío es gratis 😊', 'Mesa Auxiliar'), true);
});

test('Bloquea — "el envío va sin costo" para Escritorio Flotante', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('El envío va sin costo hasta tu casa.', 'Escritorio Flotante'), true);
});

test('Bloquea — "no te cobro el envío"', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('Tranquilo, no te cobro el envío.', 'Mesa Auxiliar'), true);
});

test('Bloquea — "el envío corre por nuestra cuenta", incluso con producto desconocido (null)', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('El envío corre por nuestra cuenta 😊', null), true);
});

test('Bloquea — "el envío no tiene costo adicional"', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('Para tu ciudad, el envío no tiene costo adicional.', 'Recibidor'), true);
});

test('Bloquea — "el precio ya incluye el envío" (envío + incluido en la misma oración, producto sin mecanismo propio)', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('El precio de $420.000 ya incluye el envío a tu ciudad.', 'Mesa Auxiliar'), true);
});

test('Bloquea — variante idiomática "no te preocupes por el envío"', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('No te preocupes por el envío, eso ya queda resuelto de nuestro lado.', 'Mesa Auxiliar'), true);
});

test('Bloquea — variante idiomática "no te preocupes por el costo de envío"', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('No te preocupes por el costo de envío 😊', 'Escritorio Flotante'), true);
});

// ─────────────────────────────────────────────────────────────────────────
// Lista blanca — producto con envío gratis aprobado explícitamente no se
// bloquea (mecanismo de excepción, no una condición ad-hoc en el código).
// ─────────────────────────────────────────────────────────────────────────
test('Lista blanca — producto agregado a PRODUCTOS_CON_ENVIO_GRATIS_APROBADO no se bloquea', function() {
  app.__setProductosConEnvioGratisAprobadoParaPruebas(['Producto De Prueba']);
  try {
    assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('El envío es gratis para este producto 😊', 'Producto De Prueba'), false);
  } finally {
    app.__setProductosConEnvioGratisAprobadoParaPruebas([]);
  }
});

test('Lista blanca — por defecto está vacía, así que Mesa Auxiliar SÍ se bloquea sin configuración extra', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('El envío es gratis 😊', 'Mesa Auxiliar'), true);
});

// ─────────────────────────────────────────────────────────────────────────
// Casos que NO deben bloquear — falsos positivos que había que evitar
// ─────────────────────────────────────────────────────────────────────────
test('NO bloquea — Repisa Flotante: "envío incluido" es una frase legítima ya usada en producción (cotizador v2 / tarifas fijas)', function() {
  const respuesta = 'Tu repisa de 110x25cm en Medellín queda en $380.000, envío incluido. ¿Arrancamos?';
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar(respuesta, 'Repisa Flotante'), false);
});

test('NO bloquea — "incluido" sin relación a envío (descuento) en una oración, envío en otra sin gratuidad', function() {
  const respuesta = 'El descuento del 10% ya queda incluido en el precio final. Para el envío te cuento en un momento.';
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar(respuesta, 'Mesa Auxiliar'), false);
});

test('NO bloquea — "no te preocupes" como reassurance de tiempo de entrega, no de costo (sin "por" después)', function() {
  const respuesta = 'No te preocupes, el envío llega en 3 días hábiles.';
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar(respuesta, 'Mesa Auxiliar'), false);
});

test('NO bloquea — mensaje sin ninguna mención de envío', function() {
  const respuesta = 'La Mesa Auxiliar Compacta es en roble macizo, patas desmontables. Queda en $390.000. ¿Arrancamos?';
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar(respuesta, 'Mesa Auxiliar'), false);
});

test('NO bloquea — respuesta vacía o no-string no rompe', function() {
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar('', 'Mesa Auxiliar'), false);
  assert.equal(app.respuestaPrometeEnvioGratisSinAprobar(undefined, 'Mesa Auxiliar'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Integración — procesarMensaje() de punta a punta: cuando Claude responde
// prometiendo envío gratis SIN el tag [ESCALAR], el mensaje que queda
// guardado (y el flujo de escalamiento/pausa) debe ser el de reemplazo fijo,
// nunca el original de Claude.
// ─────────────────────────────────────────────────────────────────────────
test('Integración — Claude promete envío gratis sin [ESCALAR]: se sustituye por el mensaje fijo y se escala', async function() {
  const numero = '573000000401';
  prepararEntorno(numero);
  app.__setLlamarClaudeParaPruebas(function() {
    return Promise.resolve({ data: { content: [{ text: 'Mesa auxiliar compacta en roble macizo, patas desmontables. Además el envío es gratis para tu ciudad 😊 ¿Arrancamos?' }] } });
  });

  await app.procesarMensaje(numero, 'Vivo en Bogotá, me interesa la mesa auxiliar', null, null);
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  const guardado = ultimoMensajeGuardado(numero);
  assert.ok(guardado.indexOf('Para confirmarte el valor exacto del envío') !== -1, 'debe guardarse el mensaje de reemplazo fijo');
  assert.equal(guardado.indexOf('gratis'), -1, 'la promesa original de envío gratis nunca debe llegar a guardarse/enviarse');
  assert.ok(guardado.indexOf('[ESCALAR]') !== -1, 'el mensaje de reemplazo debe traer el tag de escalamiento');
  assert.ok(app.pausados[numero], 'el número debe quedar pausado, igual que cualquier otro escalamiento');
});

test('Integración — Claude ya escala por su cuenta junto con la frase de envío gratis: se respeta su [ESCALAR], no se reescribe dos veces', async function() {
  const numero = '573000000402';
  prepararEntorno(numero);
  const textoOriginal = 'El envío es gratis, pero mejor te confirmo bien. Ya le aviso a Lili para que te confirme 😊 [ESCALAR]';
  app.__setLlamarClaudeParaPruebas(function() {
    return Promise.resolve({ data: { content: [{ text: textoOriginal }] } });
  });

  await app.procesarMensaje(numero, 'Vivo en Cali, me interesa la mesa auxiliar', null, null);
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  const guardado = ultimoMensajeGuardado(numero);
  assert.equal(guardado, textoOriginal, 'si Claude ya trae [ESCALAR], el filtro no debe reescribir la respuesta');
});

test('Integración — Repisa Flotante con "envío incluido" y sin [ESCALAR] pasa intacta (no la toca el filtro)', async function() {
  const numero = '573000000403';
  prepararEntorno(numero);
  const textoOriginal = 'Tu repisa de 110cm en roble macizo queda en $380.000, envío incluido. ¿Arrancamos?';
  app.__setLlamarClaudeParaPruebas(function() {
    return Promise.resolve({ data: { content: [{ text: textoOriginal }] } });
  });

  await app.procesarMensaje(numero, 'Quiero una repisa de 110cm, soy de otra ciudad', null, null);
  await new Promise(function(resolve) { setImmediate(resolve); });
  await new Promise(function(resolve) { setImmediate(resolve); });

  const guardado = ultimoMensajeGuardado(numero);
  assert.equal(guardado, textoOriginal, 'la respuesta legítima de repisas con envío incluido no debe ser reescrita');
});
