// ═══════════════════════════════════════════════════════════════════════════
// FIX 4 (29 jul) — Mesa Auxiliar: "patas desmontables" estaba escrito como
// un hecho plano del catálogo (sección 5, justo bajo las medidas/precios),
// sin condicionar a la ciudad del cliente. Confirmado con un log real:
// Olivia le dijo a un cliente de Medellín que la mesa llega con "patas
// desmontables para armar", cuando en Medellín SIEMPRE se entrega
// completamente armada — el desmontaje es exclusivo de envíos a otras
// ciudades (facilita empaque/transporte).
//
// A diferencia de FIX 3 (envío gratis), esta regla NO tiene una capa de
// código determinística que filtre la respuesta de Claude después del
// hecho — depende enteramente de que el prompt deje la condición explícita
// y sin ambigüedad. Por eso estas pruebas verifican el TEXTO del prompt
// (mismo enfoque que test/fix-catalogo-mesa-envio.test.js), no una
// simulación de "Claude respondiendo bien", que sería una prueba falsa: un
// stub de llamarClaude solo devuelve lo que el propio test le programe, no
// prueba que el modelo real vaya a seguir la instrucción.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('Mesa Auxiliar — catálogo: Medellín se entrega completamente armada, sin ensamble', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(
    prompt.indexOf('Medellín: se entrega COMPLETAMENTE ARMADA') !== -1,
    'el catálogo debe declarar explícitamente que en Medellín la mesa llega armada'
  );
});

test('Mesa Auxiliar — catálogo: prohíbe explícitamente mencionar desmontaje/tornillos para Medellín', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(
    prompt.indexOf('NUNCA digas que tiene patas desmontables ni que el cliente arma algo') !== -1,
    'debe existir una instrucción explícita de NO mencionar desmontaje/tornillos cuando el cliente es de Medellín'
  );
});

test('Mesa Auxiliar — catálogo: otra ciudad sí menciona patas desmontables y ensamble con tornillos', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(
    prompt.indexOf('Otra ciudad: se envía con patas desmontables (fácil ensamble con tornillos)') !== -1,
    'para otra ciudad el catálogo sí debe mencionar el ensamble con tornillos'
  );
});

test('Mesa Auxiliar — catálogo: ya NO existe la ficha vieja de "Patas desmontables" como hecho plano sin condicionar', function() {
  const prompt = app.getSystemPrompt();
  // La ficha vieja era una línea suelta "- Patas desmontables" (sin "Medellín"
  // ni "Otra ciudad" en la misma línea) inmediatamente bajo las opciones de
  // precio. Verificamos que ninguna línea del prompt tenga ese patrón exacto.
  const lineaVieja = prompt.split('\n').some(function(linea) {
    return linea.trim() === '- Patas desmontables';
  });
  assert.equal(lineaVieja, false, 'la ficha vieja sin condicionar a ciudad no debe existir más');
});

test('Mesa Auxiliar — catálogo: el bloque de ensamble aparece dentro de la ficha "5. MESA AUXILIAR", con Medellín antes que "Otra ciudad"', function() {
  const prompt = app.getSystemPrompt();
  const posFicha = prompt.indexOf('5. MESA AUXILIAR');
  const posMedellinArmada = prompt.indexOf('Medellín: se entrega COMPLETAMENTE ARMADA');
  const posOtraCiudadTornillos = prompt.indexOf('Otra ciudad: se envía con patas desmontables');

  assert.ok(posFicha !== -1, 'debe existir la ficha "5. MESA AUXILIAR"');
  assert.ok(posMedellinArmada > posFicha, 'la regla de Medellín debe vivir dentro de la ficha de Mesa Auxiliar');
  assert.ok(posOtraCiudadTornillos > posMedellinArmada, 'dentro de la ficha, Medellín debe aparecer antes que la excepción de otra ciudad');
});

test('Mesa Auxiliar — regla maestra (resumen de instalación/envío): también queda condicionada por ciudad', function() {
  const prompt = app.getSystemPrompt();
  const posRegla = prompt.indexOf('Mesa auxiliar → NO requiere instalación');
  assert.ok(posRegla !== -1, 'debe existir la línea de Mesa auxiliar en la regla maestra');

  const bloqueRegla = prompt.substring(posRegla, posRegla + 400);
  assert.ok(bloqueRegla.indexOf('En Medellín se entrega COMPLETAMENTE ARMADA') !== -1, 'la regla maestra debe repetir la condición de Medellín');
  assert.ok(bloqueRegla.indexOf('Únicamente en otras ciudades se envía con patas desmontables') !== -1, 'la regla maestra debe repetir la condición de otras ciudades');
  assert.ok(bloqueRegla.indexOf('NUNCA menciones desmontaje ni tornillos si el cliente es de Medellín') !== -1, 'la regla maestra debe reforzar la prohibición para Medellín');
});
