// ═══════════════════════════════════════════════════════════════════════════
// Fix urgente (29 jul) — catálogo de Mesa Auxiliar tenía una sola ficha
// mezclada (35x45x50cm, $420.000) que combinaba las dos variantes reales del
// anuncio ("Mesa auxiliar desde $390.000", Compacta/Clásica — confirmado en
// docs/PENDIENTES.md con referral_data real del lead 573174689618). Se separa
// en dos fichas y se refuerza explícitamente que el costo de envío nacional
// NUNCA se inventa/asume — se escala para que Lili confirme el valor exacto.
//
// LÍMITE RECONOCIDO (mismo de siempre, ver test/cotizador-v2-prioridad-prompt.test.js):
// estas pruebas verifican el TEXTO del prompt, no que Claude vaya a seguirlo
// en una conversación real. Eso se confirma con conversación real por
// WhatsApp, no con node:test.
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = process.env.CONTROL_TOKEN || 'token-de-prueba-fase1a';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

// ─────────────────────────────────────────────────────────────────────────
// Prueba 1 y 2 — las dos variantes con sus medidas y precios correctos
// ─────────────────────────────────────────────────────────────────────────
test('Prueba 1 — catálogo: COMPACTA es 35x45x50cm a $390.000', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('COMPACTA: 35 x 45 x 50 cm — $390.000') !== -1, 'debe existir la ficha COMPACTA con medida y precio exactos');
});

test('Prueba 2 — catálogo: CLÁSICA es 45x45x50cm a $420.000', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('CLÁSICA: 45 x 45 x 50 cm — $420.000') !== -1, 'debe existir la ficha CLÁSICA con medida y precio exactos');
});

test('Prueba 1/2 — la ficha única vieja (35x45x50cm siempre a $420.000) ya no existe', function() {
  const prompt = app.getSystemPrompt();
  assert.equal(prompt.indexOf('Medidas: 35 x 45 x 50 cm, patas desmontables'), -1, 'la ficha mezclada original debe haber sido reemplazada');
});

// ─────────────────────────────────────────────────────────────────────────
// Prueba 3 — Medellín no debe disparar la conversación de envío nacional
// (verificado por estructura: la nota de envío nacional vive dentro del
// bloque "Otra ciudad", que el prompt solo aplica cuando el cliente NO es
// de Medellín — ver REGLA MAESTRA DE INSTALACIÓN Y ENVÍO más arriba).
// ─────────────────────────────────────────────────────────────────────────
test('Prueba 3 — la nota de envío nacional está en la sección "Otra ciudad", no en la regla general de Medellín', function() {
  const prompt = app.getSystemPrompt();
  const posOtraCiudad = prompt.indexOf('Otra ciudad — DEPENDE DEL PRODUCTO');
  const posNotaEnvioMesa = prompt.indexOf('MESA AUXILIAR: se envía a todo Colombia');
  assert.ok(posOtraCiudad !== -1 && posNotaEnvioMesa !== -1, 'ambas secciones deben existir');
  assert.ok(posNotaEnvioMesa > posOtraCiudad, 'la nota de Mesa Auxiliar debe vivir dentro del bloque de "otra ciudad", no aplicar a Medellín');
});

// ─────────────────────────────────────────────────────────────────────────
// Prueba 4 — otra ciudad (Bogotá u otra): confirma que sí se envía, pero
// escala para el costo exacto — nunca lo inventa.
// ─────────────────────────────────────────────────────────────────────────
test('Prueba 4 — otra ciudad: el prompt instruye confirmar que sí se envía y escalar para el valor exacto', function() {
  const prompt = app.getSystemPrompt();
  const bloque = prompt.slice(prompt.indexOf('MESA AUXILIAR: se envía a todo Colombia'), prompt.indexOf('MESA AUXILIAR: se envía a todo Colombia') + 400);
  assert.ok(bloque.indexOf('El costo del envío NO está incluido') !== -1, 'debe declarar explícitamente que el envío no está incluido');
  assert.ok(bloque.indexOf('NUNCA lo inventas ni lo asumes en $0') !== -1, 'debe prohibir inventar o asumir el costo');
  assert.ok(bloque.indexOf('[ESCALAR]') !== -1, 'debe traer una frase de escalamiento lista para usar');
});

// ─────────────────────────────────────────────────────────────────────────
// Prueba 5 — "¿el envío está incluido?": la ficha del catálogo ya declara
// que el envío nacional tiene costo adicional NO incluido, y que se escala.
// ─────────────────────────────────────────────────────────────────────────
test('Prueba 5 — la ficha del catálogo declara que el envío NO está incluido en el precio del mueble', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('con costo adicional NO incluido en el precio del mueble') !== -1);
  assert.ok(prompt.indexOf('NUNCA inventes ni asumas el costo de envío') !== -1);
  assert.ok(prompt.indexOf('escala a Lili para que confirme el valor exacto') !== -1);
});

// ─────────────────────────────────────────────────────────────────────────
// Prueba 6 — nunca prometer envío gratis: verificado en dos capas de texto
// independientes que cualquier formulación de la pregunta del cliente debe
// activar (no una lista de frases del cliente, sino la regla que cubre la
// respuesta de Olivia): la REGLA MAESTRA general (aplica a TODOS los
// productos, ya existía) + la nota específica nueva de Mesa Auxiliar.
// La robustez frente a distintas formulaciones del CLIENTE depende de que
// Claude generalice la instrucción — no hay una lista de frases del cliente
// que interceptar en el prompt; ver FIX 3 (pendiente de aprobación) para la
// capa adicional de defensa sobre el TEXTO DE SALIDA de Olivia.
// ─────────────────────────────────────────────────────────────────────────
test('Prueba 6 — dos capas de prompt prohíben inventar/prometer envío gratis para Mesa Auxiliar', function() {
  const prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('NUNCA inventes datos: ni precios, ni medidas, ni costos de envío') !== -1, 'la regla maestra general debe seguir intacta');
  assert.ok(prompt.indexOf('NUNCA inventes ni asumas el costo de envío') !== -1, 'la nota específica de Mesa Auxiliar debe existir');
  assert.ok(prompt.indexOf('NUNCA lo inventas ni lo asumes en $0') !== -1, 'la nota de "otra ciudad" debe prohibir asumir envío gratis explícitamente');
});
