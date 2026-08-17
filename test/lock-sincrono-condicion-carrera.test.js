// ═══════════════════════════════════════════════════════════════════════════
// Condición de carrera del webhook (auditoría 2 ago 2026) — lead real
// Fernando Escobar (573014597175), 1 ago 11:58am: tres mensajes en ráfaga
// de ~7 segundos ("Bogotá", "¿Tendrás más fotos?", "Hola buen día"). El
// guard `procesando[from]` se reclamaba DENTRO del .then() de
// capturarMensajeCRM() — es decir, después de un round-trip async a la BD —
// así que dos mensajes en ráfaga pasaban el guard a la vez: uno se perdía en
// silencio, el otro disparaba un saludo genérico ignorando lo ya hablado.
//
// Fix: la reclamación pasa a ser SÍNCRONA (reclamarLockProcesando(), en
// whatsapp_agent.js junto a la declaración de `procesando`), en el mismo
// tick que procesa el webhook, antes de cualquier await/promesa. Se prueba
// aquí como función pura (mismo criterio que el resto de la suite: no se
// monta el webhook HTTP real, ver test/webhook-tipo-mensaje.test.js) porque
// modela exactamente la garantía que da Node de un solo hilo: dos handlers
// de webhook que llegan casi al mismo tiempo ejecutan su porción síncrona
// uno después del otro, nunca intercalados, hasta el primer await/.then().
//
// Limitación aceptada (documentada, no un bug): el lock por sí solo evita la
// corrupción, pero un segundo mensaje en ráfaga se guarda en el historial
// sin generar respuesta en esa pasada. La solución completa (cola/debounce
// que agrupe mensajes consecutivos y responda una sola vez) queda para la
// siguiente iteración.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('reclamarLockProcesando — el primer mensaje de un número reclama el lock (devuelve false)', function() {
  const numero = '573001112233';
  delete app.procesando[numero];
  assert.equal(app.reclamarLockProcesando(numero), false);
  assert.equal(app.procesando[numero], true);
});

test('reclamarLockProcesando — un segundo mensaje del mismo número, con el lock ya tomado, NO lo reclama (devuelve true)', function() {
  const numero = '573001112234';
  delete app.procesando[numero];
  app.reclamarLockProcesando(numero); // primer mensaje reclama
  assert.equal(app.reclamarLockProcesando(numero), true); // segundo mensaje encuentra el lock tomado
  assert.equal(app.procesando[numero], true, 'el lock sigue tomado, no se pisa');
});

test('liberarLockSiLoReclamamos — libera el lock si quien llama fue quien lo reclamó', function() {
  const numero = '573001112235';
  delete app.procesando[numero];
  const yaHabiaMensajeEnProceso = app.reclamarLockProcesando(numero);
  app.liberarLockSiLoReclamamos(numero, yaHabiaMensajeEnProceso);
  assert.equal(app.procesando[numero], undefined, 'quien lo reclamó puede liberarlo');
});

test('liberarLockSiLoReclamamos — NUNCA libera el lock de OTRO mensaje que no reclamamos', function() {
  const numero = '573001112236';
  delete app.procesando[numero];
  app.reclamarLockProcesando(numero); // mensaje 1 reclama y sigue procesando (no libera)
  const yaHabiaMensajeEnProcesoDelMensaje2 = app.reclamarLockProcesando(numero); // mensaje 2 encuentra el lock tomado -> true
  app.liberarLockSiLoReclamamos(numero, yaHabiaMensajeEnProcesoDelMensaje2); // mensaje 2 intenta "liberar" lo que no reclamó
  assert.equal(app.procesando[numero], true, 'el lock del mensaje 1 sigue intacto');
});

// ─────────────────────────────────────────────────────────────────────────
// Caso real: Fernando Escobar, 3 mensajes en ráfaga del mismo número.
// Antes del fix, la reclamación async dejaba pasar más de uno. Con el lock
// síncrono, solo el primero de la ráfaga debe llegar al punto donde el
// webhook programaría procesarMensaje() — los otros dos deben quedar
// bloqueados por el lock, sin tocar el del primero.
// ─────────────────────────────────────────────────────────────────────────
test('caso real Fernando Escobar — 3 mensajes en ráfaga del mismo número: solo el primero dispara procesarMensaje()', function() {
  const numero = '573014597175';
  delete app.procesando[numero];

  const mensajes = ['Bogotá', '¿Tendrás más fotos?', 'Hola buen día'];
  const dispararianProcesarMensaje = mensajes.map(function() {
    // Simula, para cada mensaje de la ráfaga, exactamente lo que hace el
    // webhook de forma síncrona ANTES de esperar a capturarMensajeCRM():
    // reclamar el lock y decidir si este mensaje llegaría hasta
    // procesarMensaje() (solo si nadie más lo tenía tomado).
    const yaHabiaMensajeEnProceso = app.reclamarLockProcesando(numero);
    return !yaHabiaMensajeEnProceso;
  });

  assert.deepEqual(dispararianProcesarMensaje, [true, false, false],
    'solo el primer mensaje de la ráfaga dispara procesarMensaje(); los otros dos quedan guardados pero sin respuesta en esa pasada');
  assert.equal(app.procesando[numero], true, 'el lock queda tomado por el primer mensaje hasta que procesarMensaje() lo libere');
});
