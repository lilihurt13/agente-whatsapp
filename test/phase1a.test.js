// ═══════════════════════════════════════════════════════════════════════════
// Fase 1A — Sección 11, Casos A-H. Ejecutar con: npm test
//
// Estos son pruebas contra un `pool` SIMULADO a mano (ver
// test/helpers/fakePool.js) — NO contra Postgres real. Validan la
// ORQUESTACIÓN en JS (orden de llamadas, eventos correctos, formas de
// retorno), no la semántica real de SQL (constraints UNIQUE, ON CONFLICT,
// operadores JSONB). Esa verificación queda pendiente contra un Postgres de
// prueba real — ver docs/PHASE_1A_TESTING.md para el porqué de esta
// limitación y el plan para cerrarla.
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = 'token-de-prueba-fase1a';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crearPoolSimulado, esperarMicrotareas } = require('./helpers/fakePool');
const app = require('../whatsapp_agent.js');

function poolFresco() {
  const p = crearPoolSimulado();
  app.__setPoolParaPruebas(p);
  return p;
}

function eventosDe(pool, tipo) {
  return pool._estado.leadEvents.filter(function(e) { return e.event_type === tipo; });
}

// ─────────────────────────────────────────────────────────────────────────
// CASO A: Mensaje nuevo sin lead existente.
// Esperado: crea lead; crea message; crea LEAD_CREATED; crea MESSAGE_RECEIVED.
// ─────────────────────────────────────────────────────────────────────────
test('Caso A — mensaje nuevo sin lead existente crea lead, message y sus eventos', async function() {
  const pool = poolFresco();
  const numero = '573000000001';

  const resultado = await app.capturarMensajeCRM(numero, {
    whatsappMessageId: 'wamid.CASOA',
    direction: 'INBOUND',
    senderType: 'CUSTOMER',
    messageType: 'text',
    textContent: 'Hola, quiero una repisa',
    rawPayload: { id: 'wamid.CASOA' },
    occurredAt: new Date()
  });
  await esperarMicrotareas();

  assert.equal(resultado.duplicado, false);
  assert.equal(resultado.error, false);
  assert.ok(resultado.mensajeId, 'debe devolver un mensajeId');
  assert.equal(resultado.lead.whatsapp_phone, numero);

  assert.equal(pool._estado.leads.length, 1, 'debe crear exactamente 1 lead');
  assert.equal(pool._estado.messages.length, 1, 'debe crear exactamente 1 message');

  assert.equal(eventosDe(pool, 'LEAD_CREATED').length, 1, 'debe emitir LEAD_CREATED una vez');
  assert.equal(eventosDe(pool, 'MESSAGE_RECEIVED').length, 1, 'debe emitir MESSAGE_RECEIVED una vez');
});

// ─────────────────────────────────────────────────────────────────────────
// CASO B: Mensaje nuevo con lead existente.
// Esperado: no duplica lead; agrega message; actualiza timestamps.
// ─────────────────────────────────────────────────────────────────────────
test('Caso B — segundo mensaje del mismo número no duplica el lead', async function() {
  const pool = poolFresco();
  const numero = '573000000002';

  const r1 = await app.capturarMensajeCRM(numero, {
    whatsappMessageId: 'wamid.CASOB-1', direction: 'INBOUND', senderType: 'CUSTOMER',
    messageType: 'text', textContent: 'Hola', rawPayload: {}, occurredAt: new Date()
  });
  const r2 = await app.capturarMensajeCRM(numero, {
    whatsappMessageId: 'wamid.CASOB-2', direction: 'INBOUND', senderType: 'CUSTOMER',
    messageType: 'text', textContent: 'Otra vez yo', rawPayload: {}, occurredAt: new Date()
  });
  await esperarMicrotareas();

  assert.equal(pool._estado.leads.length, 1, 'sigue habiendo un solo lead para este número');
  assert.equal(pool._estado.messages.length, 2, 'ambos mensajes quedan guardados');
  assert.equal(r1.lead.id, r2.lead.id, 'los dos mensajes apuntan al mismo lead_id');

  assert.equal(eventosDe(pool, 'LEAD_CREATED').length, 1, 'LEAD_CREATED solo se emite en el primer mensaje');
  assert.equal(eventosDe(pool, 'MESSAGE_RECEIVED').length, 2, 'MESSAGE_RECEIVED se emite una vez por mensaje');

  const lead = pool._estado.leads[0];
  assert.ok(lead.last_customer_message_at, 'last_customer_message_at debe quedar actualizado');
});

// ─────────────────────────────────────────────────────────────────────────
// CASO C: Webhook duplicado con el mismo message_id.
// Esperado: una sola fila en messages; evento DUPLICATE_WEBHOOK_IGNORED;
// ningún MESSAGE_RECEIVED adicional (= no se reprocesa IA/reenvío).
// ─────────────────────────────────────────────────────────────────────────
test('Caso C — el mismo whatsapp_message_id dos veces no duplica nada', async function() {
  const pool = poolFresco();
  const numero = '573000000003';
  const opts = {
    whatsappMessageId: 'wamid.CASOC-REPETIDO', direction: 'INBOUND', senderType: 'CUSTOMER',
    messageType: 'text', textContent: 'Mismo mensaje', rawPayload: {}, occurredAt: new Date()
  };

  const primera = await app.capturarMensajeCRM(numero, opts);
  const segunda = await app.capturarMensajeCRM(numero, opts); // reintento/reentrega de Meta
  await esperarMicrotareas();

  assert.equal(primera.duplicado, false, 'la primera entrega se procesa normalmente');
  assert.equal(segunda.duplicado, true, 'la segunda entrega se reconoce como duplicado');
  assert.equal(segunda.mensajeId, null, 'la entrega duplicada no genera un mensajeId nuevo');

  assert.equal(pool._estado.messages.length, 1, 'una sola fila en messages, no dos');
  assert.equal(eventosDe(pool, 'MESSAGE_RECEIVED').length, 1, 'MESSAGE_RECEIVED no se repite');
  assert.equal(eventosDe(pool, 'DUPLICATE_WEBHOOK_IGNORED').length, 1, 'se emite DUPLICATE_WEBHOOK_IGNORED una vez');
});

// ─────────────────────────────────────────────────────────────────────────
// CASO D: Mensaje con referral parcial.
// Esperado: guarda referral; extrae solo campos presentes; un evento
// posterior con menos campos no borra los ya confirmados (no reemplaza con null).
// ─────────────────────────────────────────────────────────────────────────
test('Caso D — referral parcial se guarda y no se borra con eventos posteriores incompletos', async function() {
  const pool = poolFresco();
  const numero = '573000000004';

  const { lead } = await app.obtenerOCrearLead(numero);

  app.capturarReferral(lead, { ad_id: '999', ctwa_clid: 'primero' }, 'wamid.CASOD-1');
  await esperarMicrotareas();

  let leadActualizado = pool._estado.leads.find(function(l) { return l.id === lead.id; });
  assert.equal(leadActualizado.referral_data.ad_id, '999');
  assert.equal(leadActualizado.referral_data.ctwa_clid, 'primero');
  assert.equal(leadActualizado.ad_id, '999', 'la columna ad_id también queda extraída');
  assert.equal(leadActualizado.campaign_id, null, 'campaign_id sigue null — nunca llegó, no se inventa');

  // Segundo evento de referral SIN ad_id (parcial) — no debe borrar el ad_id ya confirmado
  app.capturarReferral(lead, { ctwa_clid: 'segundo' }, 'wamid.CASOD-2');
  await esperarMicrotareas();

  leadActualizado = pool._estado.leads.find(function(l) { return l.id === lead.id; });
  assert.equal(leadActualizado.referral_data.ad_id, '999', 'ad_id NO se borra aunque el 2do evento no lo traiga');
  assert.equal(leadActualizado.referral_data.ctwa_clid, 'segundo', 'ctwa_clid sí se actualiza al valor más reciente');

  assert.equal(eventosDe(pool, 'REFERRAL_CAPTURED').length, 2, 'un evento REFERRAL_CAPTURED por cada referral recibido');
});

// ─────────────────────────────────────────────────────────────────────────
// CASO E: Payload sin referral.
// Esperado: no rompe; no genera ningún evento ni escritura de referral.
// ─────────────────────────────────────────────────────────────────────────
test('Caso E — sin referral no pasa nada (no rompe, no escribe, no genera evento)', async function() {
  const pool = poolFresco();
  const numero = '573000000005';
  const { lead } = await app.obtenerOCrearLead(numero);

  assert.doesNotThrow(function() { app.capturarReferral(lead, null, 'wamid.CASOE-1'); });
  assert.doesNotThrow(function() { app.capturarReferral(lead, undefined, 'wamid.CASOE-2'); });
  await esperarMicrotareas();

  assert.equal(eventosDe(pool, 'REFERRAL_CAPTURED').length, 0, 'sin referral, no se emite REFERRAL_CAPTURED');

  // El flujo base (Caso A) sigue funcionando igual sin que referral participe en nada:
  const resultado = await app.capturarMensajeCRM(numero, {
    whatsappMessageId: 'wamid.CASOE-3', direction: 'INBOUND', senderType: 'CUSTOMER',
    messageType: 'text', textContent: 'Mensaje normal sin referral', rawPayload: {}, occurredAt: new Date()
  });
  assert.equal(resultado.duplicado, false);
  assert.ok(resultado.mensajeId);
});

// ─────────────────────────────────────────────────────────────────────────
// CASO F: Leadgen recibido dos veces.
// Esperado: una sola captura lógica; sin registros duplicados.
//
// NOTA DE ALCANCE: esta prueba simula el estado "ya recibido una vez"
// directamente (pre-sembrando lead_form_submissions) en vez de ejercitar
// una primera recepción real, porque esa primera recepción llamaría a la
// Graph API de verdad (axios.get contra graph.facebook.com) — y esa
// integración todavía depende de configuración de Meta pendiente de
// confirmar (Paso 7). Lo que sí se prueba aquí, con total honestidad, es
// la garantía de deduplicación por leadgen_id, que es lo que este caso pide.
// ─────────────────────────────────────────────────────────────────────────
test('Caso F — leadgen_id ya recibido antes se ignora sin duplicar ni reprocesar', async function() {
  const pool = poolFresco();
  const leadgenId = 'LEADGEN-CASOF-123';

  // Pre-sembrado: simula que la PRIMERA entrega de este leadgen_id ya se procesó.
  pool._estado.leadFormSubmissions.push({
    id: 1, leadgen_id: leadgenId, page_id: 'PAGE1', form_id: 'FORM1',
    ad_id: 'AD1', adgroup_id: 'ADSET1', estado_vinculacion: 'PENDIENTE',
    field_data: [], lead_id: null
  });
  pool._estado.siguienteSubmissionId = 2;

  // Esta llamada representa la SEGUNDA entrega (reentrega/reintento de Meta).
  await app.manejarEventoLeadgen({
    leadgen_id: leadgenId, page_id: 'PAGE1', form_id: 'FORM1', ad_id: 'AD1', adgroup_id: 'ADSET1'
  });
  await esperarMicrotareas();

  assert.equal(pool._estado.leadFormSubmissions.length, 1, 'sigue habiendo una sola fila — no se duplicó');
  assert.equal(eventosDe(pool, 'DUPLICATE_WEBHOOK_IGNORED').length, 1, 'se emite DUPLICATE_WEBHOOK_IGNORED');
  assert.equal(eventosDe(pool, 'LEAD_FORM_WEBHOOK_RECEIVED').length, 0, 'NO se vuelve a emitir como si fuera nuevo');
});

// ─────────────────────────────────────────────────────────────────────────
// CASO G: Registro manual de mensaje de Lili.
// Esperado: se guarda como OUTBOUND/LILI; Olivia queda desactivada; no se
// envía ningún mensaje por WhatsApp (confirmado por inspección de código:
// esta ruta nunca llama a enviarMensaje()).
// ─────────────────────────────────────────────────────────────────────────
test('Caso G — endpoint de mensaje manual registra OUTBOUND/LILI y desactiva a Olivia', async function() {
  const pool = poolFresco();
  const numero = '573000000007';
  const { lead } = await app.obtenerOCrearLead(numero);

  const server = app.listen(0);
  try {
    const puerto = server.address().port;
    const resp = await fetch('http://127.0.0.1:' + puerto + '/api/leads/' + lead.id + '/manual-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        token: process.env.CONTROL_TOKEN,
        text: 'Ya le respondí desde WhatsApp Business directamente',
        internal_note: 'Cliente pidió factura'
      })
    });
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.messageId);

    const mensajeGuardado = pool._estado.messages.find(function(m) { return m.id === body.messageId; });
    assert.ok(mensajeGuardado, 'el mensaje debe existir en la tabla simulada');
    assert.equal(mensajeGuardado.direction, 'OUTBOUND');
    assert.equal(mensajeGuardado.sender_type, 'LILI');
    assert.equal(mensajeGuardado.whatsapp_message_id, null, 'no viene de WhatsApp, no tiene whatsapp_message_id');

    const leadActualizado = pool._estado.leads.find(function(l) { return l.id === lead.id; });
    assert.equal(leadActualizado.owner, 'LILI');
    assert.equal(leadActualizado.olivia_enabled, false);

    const eventos = eventosDe(pool, 'MANUAL_MESSAGE_RECORDED');
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].metadata.via, 'panel_manual_endpoint');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Caso G (bis) — el endpoint rechaza sin el token correcto', async function() {
  poolFresco();
  const numero = '573000000008';
  const { lead } = await app.obtenerOCrearLead(numero);

  const server = app.listen(0);
  try {
    const puerto = server.address().port;
    const resp = await fetch('http://127.0.0.1:' + puerto + '/api/leads/' + lead.id + '/manual-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({ token: 'token-incorrecto', text: 'intento sin autorización' })
    });
    assert.equal(resp.status, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// CASO H: `conversaciones` sigue usando los últimos 12 mensajes para el
// contexto de Claude — comportamiento legacy sin cambios por la Fase 1A.
// ─────────────────────────────────────────────────────────────────────────
test('Caso H — conversaciones sigue recortando a los últimos 12 mensajes', async function() {
  poolFresco();
  const numero = '573000000009';
  delete app.conversaciones[numero]; // aislar de cualquier estado previo

  for (let i = 1; i <= 15; i++) {
    app.agregarMensaje(numero, i % 2 === 0 ? 'assistant' : 'user', 'mensaje numero ' + i);
  }

  const historial = app.conversaciones[numero];
  assert.equal(historial.length, 12, 'el historial en memoria sigue recortado a 12');
  assert.equal(historial[0].content, 'mensaje numero 4', 'se conservan los últimos 12 (se descartan los 3 más viejos)');
  assert.equal(historial[11].content, 'mensaje numero 15');
});
