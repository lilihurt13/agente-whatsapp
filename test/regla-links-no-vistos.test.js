// ═══════════════════════════════════════════════════════════════════════════
// Etapa 2, punto 1 (3 ago 2026) — regla de links/imágenes no vistos (caso
// real Alex: compartió un link de Facebook, Olivia no debía asumir qué
// mostraba). Igual que con audio/archivo, un link de texto no es contenido
// que Claude pueda "ver" — se agrega al system prompt junto a esa regla
// existente, con una regla permanente que evita que Olivia confirme en un
// turno posterior algo que nunca vio (imagen ambigua, audio, archivo, o
// link) solo porque el cliente responde corto ("sí", "esos").
//
// Solo se prueba que el texto exacto esté presente en getSystemPrompt() —
// mismo criterio que el resto de la suite para reglas de prompt (ver
// test/fotos-por-producto.test.js).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('getSystemPrompt — incluye la regla de links no vistos junto a audio/archivo', function() {
  var prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('Si el cliente comparte un link (Facebook, Instagram, cualquier URL) como texto, no puedes ver su contenido') !== -1);
  assert.ok(prompt.indexOf('¡Gracias por compartir el link! 😊 Ya le aviso a Lili para que lo revise. En un momentico te escribe. [ESCALAR]') !== -1);
});

test('getSystemPrompt — incluye la regla permanente de no asumir contenido no visto', function() {
  var prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('REGLA PERMANENTE: si en cualquier momento de la conversación escalaste algo porque no podías verlo') !== -1);
  assert.ok(prompt.indexOf('NUNCA en un turno posterior afirmes con seguridad qué contenía') !== -1);
  assert.ok(prompt.indexOf('sigue tratándolo como no visto') !== -1);
});

test('getSystemPrompt — la regla de links queda después de la de audio/archivo (mismo bloque de contenido no visible)', function() {
  var prompt = app.getSystemPrompt();
  var indiceAudioArchivo = prompt.indexOf('no puedes verlo ni escucharlo');
  var indiceLink = prompt.indexOf('no puedes ver su contenido');
  assert.ok(indiceAudioArchivo !== -1 && indiceLink !== -1);
  assert.ok(indiceLink > indiceAudioArchivo, 'la regla de links debe estar junto/después de la de audio/archivo, no en otra parte del prompt');
});
