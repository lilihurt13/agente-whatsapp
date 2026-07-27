// ═══════════════════════════════════════════════════════════════════════════
// Cotizador v2 de repisas — continuidad entre turnos (27 jul, tercer ajuste
// de esta misma sesión). Con historial limpio, un lead de prueba mostró
// avance real: "Tienes de 110 x 25 cm" ya no escalaba y Olivia preguntaba
// la ciudad correctamente. Pero al responder solo "Medellín", volvía a
// escalar en vez de combinar la medida del turno anterior con la ciudad
// del turno actual y emitir el tag.
//
// Fix: nueva instrucción explícita en bloqueCotizadorV2 (sección
// "CONTINUIDAD ENTRE TURNOS") — cuando el cliente responde solo con la
// ciudad después de que Olivia la preguntó, y la medida ya estaba
// confirmada en un mensaje anterior, debe combinar ambos datos y emitir
// el tag, nunca escalar. No se tocó resolverPrecioRepisa() ni la fórmula.
//
// LÍMITE RECONOCIDO (el mismo de siempre): estas pruebas verifican que (a)
// el texto del prompt tiene la instrucción de continuidad, y (b) el
// historial de conversación (conversaciones[from]) SÍ se pasa completo a
// Claude en cada llamada (mensajesLimpios se arma desde conversaciones[from]
// — ver procesarMensaje()), y (c) SI Claude emite el tag combinando ambos
// turnos, nuestro código lo procesa bien de punta a punta. Ninguna prueba
// aquí puede forzar que el modelo real combine los turnos — eso se
// confirma con conversación real.
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

function ultimoMensajeGuardado(numero) {
  var conv = app.conversaciones[numero] || [];
  return conv.length > 0 ? conv[conv.length - 1].content : null;
}

// Simula que el turno 1 ("Tienes de 110 x 25 cm" → Olivia pregunta ciudad)
// ya quedó guardado en el historial, tal como lo dejaría procesarMensaje()
// en una conversación real.
function sembrarTurno1(numero) {
  app.__setPreciosRepisasParaPruebas(CATALOGO_SEMBRADO);
  delete app.pausados[numero];
  app.conversaciones[numero] = [
    { role: 'user', content: 'Tienes de 110 x 25 cm', ts: Date.now() - 5000 },
    { role: 'assistant', content: 'Claro, esa medida la fabricamos con gusto 😊 ¿Es para Medellín o para otra ciudad?', ts: Date.now() - 4000 }
  ];
  app.__setPoolParaPruebas({ query: function() { return Promise.resolve({ rows: [] }); } });
}

// ─────────────────────────────────────────────────────────────────────────
// Texto del prompt — la instrucción de continuidad existe
// ─────────────────────────────────────────────────────────────────────────
test('getSystemPrompt — con el flag encendido, instruye combinar medida de un turno anterior con la ciudad del turno actual', function() {
  conFlagV2(function() {
    const prompt = app.getSystemPrompt();
    assert.ok(prompt.indexOf('CONTINUIDAD ENTRE TURNOS') !== -1);
    assert.ok(prompt.indexOf('Combina la medida que ya tenías') !== -1);
    ['Soy de Medellín', 'En Medellín', 'Estoy en Medellín', 'Para Medellín'].forEach(function(variante) {
      assert.ok(prompt.indexOf(variante) !== -1, 'debe mencionar la variante "' + variante + '"');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// El historial completo (incluido el turno 1) SÍ llega a Claude — condición
// necesaria para que el modelo pueda combinar los datos, aunque no la
// garantice.
// ─────────────────────────────────────────────────────────────────────────
['Medellín', 'Soy de Medellín', 'En Medellín', 'Estoy en Medellín', 'Para Medellín'].forEach(function(respuestaCiudad) {
  test('Turno 2 ("' + respuestaCiudad + '") — el historial del turno 1 (medida) llega completo a Claude y, si emite el tag, calcula $380.000', async function() {
    const numero = '573000000401_' + respuestaCiudad.replace(/\s+/g, '_');
    sembrarTurno1(numero);

    let numeroDeLlamada = 0;
    app.__setLlamarClaudeParaPruebas(function(systemPrompt, mensajes) {
      numeroDeLlamada++;
      if (numeroDeLlamada === 1) {
        const huboMedidaEnHistorial = mensajes.some(function(m) {
          return typeof m.content === 'string' && m.content.indexOf('110 x 25') !== -1;
        });
        assert.ok(huboMedidaEnHistorial, 'el mensaje del turno 1 con la medida debe seguir en el historial pasado a Claude');
        return Promise.resolve({ data: { content: [{ text: '[COTIZAR_REPISA:largo=110,prof=25,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]' }] } });
      }
      assert.ok(systemPrompt.indexOf('380.000') !== -1);
      return Promise.resolve({ data: { content: [{ text: '¡Listo! 😊 Tu repisa de 110x25cm en Medellín queda en $380.000. ¿Arrancamos?' }] } });
    });

    await app.procesarMensaje(numero, respuestaCiudad, null, null);
    await new Promise(function(resolve) { setImmediate(resolve); });
    await new Promise(function(resolve) { setImmediate(resolve); });

    assert.equal(numeroDeLlamada, 2, 'debe llegar hasta la segunda llamada (precio calculado), no escalar en el camino');
    const guardado = ultimoMensajeGuardado(numero);
    assert.ok(guardado.indexOf('380.000') !== -1);
    assert.equal(guardado.indexOf('COTIZAR_REPISA'), -1);
  });
});
