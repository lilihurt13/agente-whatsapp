// ═══════════════════════════════════════════════════════════════════════════
// Simulación manual de `pool.query` para las pruebas de la Fase 1A (Paso 11).
//
// LÍMITE RECONOCIDO (ver docs/PHASE_1A_TESTING.md): esto NO valida semántica
// real de Postgres. Reimplementa a mano, en JS, lo que se ASUME que hacen
// `ON CONFLICT DO NOTHING`, el merge `||` de JSONB, y `COALESCE` — exactamente
// el tipo de suposición que un bug real de SQL no dispararía. Sirve para
// probar la ORQUESTACIÓN en JS (¿se llama a la función correcta con los
// argumentos correctos? ¿se dispara el evento correcto? ¿el resultado
// devuelto tiene la forma esperada?), no la corrección del SQL en sí.
//
// La verificación de que el SQL real (constraints UNIQUE, ON CONFLICT,
// operadores JSONB) se comporta como este simulador asume queda pendiente
// para una prueba de integración contra un Postgres real (TEST_DATABASE_URL)
// — ver docs/PHASE_1A_TESTING.md.
// ═══════════════════════════════════════════════════════════════════════════

function normalizar(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function crearPoolSimulado() {
  const estado = {
    leads: [],
    messages: [],
    leadEvents: [],
    leadFormSubmissions: [],
    siguienteLeadId: 1,
    siguienteMensajeId: 1,
    siguienteEventoId: 1,
    siguienteSubmissionId: 1
  };
  const llamadas = [];

  function query(sql, params) {
    params = params || [];
    const s = normalizar(sql);
    llamadas.push({ sql: s, params: params });

    // --- leads: búsqueda por teléfono ---
    if (s.indexOf('SELECT * FROM leads WHERE whatsapp_phone = $1') === 0) {
      const encontrado = estado.leads.find(function(l) { return l.whatsapp_phone === params[0]; });
      return Promise.resolve({ rows: encontrado ? [encontrado] : [] });
    }

    // --- leads: búsqueda por id ---
    if (s.indexOf('SELECT * FROM leads WHERE id = $1') === 0) {
      const encontrado = estado.leads.find(function(l) { return l.id === params[0]; });
      return Promise.resolve({ rows: encontrado ? [encontrado] : [] });
    }

    // --- leads: creación (ON CONFLICT DO NOTHING RETURNING *) ---
    if (s.indexOf('INSERT INTO leads (whatsapp_phone, owner, olivia_enabled, lifecycle_stage, first_contact_at)') === 0) {
      const yaExiste = estado.leads.some(function(l) { return l.whatsapp_phone === params[0]; });
      if (yaExiste) return Promise.resolve({ rows: [] }); // simula el conflicto -> DO NOTHING
      const nuevo = {
        id: estado.siguienteLeadId++,
        whatsapp_phone: params[0],
        owner: params[1],
        olivia_enabled: params[2],
        lifecycle_stage: params[3],
        campaign_id: null, adset_id: null, ad_id: null, source: null,
        referral_data: {}, lead_form_data: {}, form_id: null,
        last_customer_message_at: null, last_business_message_at: null
      };
      estado.leads.push(nuevo);
      return Promise.resolve({ rows: [nuevo] });
    }

    // --- leads: referral (merge) ---
    if (s.indexOf('UPDATE leads SET referral_data = referral_data || $2::jsonb') === 0) {
      const lead = estado.leads.find(function(l) { return l.id === params[0]; });
      if (lead) {
        const nuevosCampos = JSON.parse(params[1]);
        lead.referral_data = Object.assign({}, lead.referral_data, nuevosCampos);
        if (params[2]) lead.campaign_id = params[2];
        if (params[3]) lead.adset_id = params[3];
        if (params[4]) lead.ad_id = params[4];
        if (!lead.source) lead.source = 'ctwa_referral';
      }
      return Promise.resolve({ rows: [] });
    }

    // --- leads: mensaje manual (owner/olivia_enabled/last_business_message_at) ---
    if (s.indexOf("UPDATE leads SET owner = 'LILI', olivia_enabled = false") === 0) {
      const lead = estado.leads.find(function(l) { return l.id === params[0]; });
      if (lead) { lead.owner = 'LILI'; lead.olivia_enabled = false; lead.last_business_message_at = new Date(); }
      return Promise.resolve({ rows: [] });
    }

    // --- leads: actualizar timestamp genérico ---
    if (s.indexOf('UPDATE leads SET last_customer_message_at = NOW()') === 0 ||
        s.indexOf('UPDATE leads SET last_business_message_at = NOW()') === 0) {
      const lead = estado.leads.find(function(l) { return l.id === params[0]; });
      if (lead) {
        if (s.indexOf('last_customer_message_at') !== -1) lead.last_customer_message_at = new Date();
        if (s.indexOf('last_business_message_at') !== -1) lead.last_business_message_at = new Date();
      }
      return Promise.resolve({ rows: [] });
    }

    // --- messages: creación (ON CONFLICT DO NOTHING RETURNING id), vía capturarMensajeCRM ---
    if (s.indexOf('INSERT INTO messages (lead_id, whatsapp_message_id, direction, sender_type, message_type, text_content, media_id, raw_payload, occurred_at)') === 0) {
      const whatsappMessageId = params[1];
      if (whatsappMessageId && estado.messages.some(function(m) { return m.whatsapp_message_id === whatsappMessageId; })) {
        return Promise.resolve({ rows: [] }); // simula el conflicto -> DO NOTHING
      }
      const nuevo = {
        id: estado.siguienteMensajeId++,
        lead_id: params[0], whatsapp_message_id: whatsappMessageId, direction: params[2],
        sender_type: params[3], message_type: params[4], text_content: params[5],
        media_id: params[6], raw_payload: params[7], occurred_at: params[8]
      };
      estado.messages.push(nuevo);
      return Promise.resolve({ rows: [{ id: nuevo.id }] });
    }

    // --- messages: creación desde el endpoint de mensaje manual (siempre whatsapp_message_id NULL) ---
    if (s.indexOf('INSERT INTO messages (lead_id, whatsapp_message_id, direction, sender_type, message_type, text_content, raw_payload, occurred_at)') === 0) {
      const nuevo = {
        id: estado.siguienteMensajeId++,
        lead_id: params[0], whatsapp_message_id: null, direction: params[1],
        sender_type: params[2], message_type: params[3], text_content: params[4],
        raw_payload: params[5], occurred_at: params[6]
      };
      estado.messages.push(nuevo);
      return Promise.resolve({ rows: [{ id: nuevo.id }] });
    }

    // --- lead_events: registro ---
    if (s.indexOf('INSERT INTO lead_events (lead_id, event_type, actor, source, metadata, whatsapp_message_id)') === 0) {
      const nuevo = {
        id: estado.siguienteEventoId++,
        lead_id: params[0], event_type: params[1], actor: params[2],
        source: params[3], metadata: JSON.parse(params[4]), whatsapp_message_id: params[5]
      };
      estado.leadEvents.push(nuevo);
      return Promise.resolve({ rows: [] });
    }

    // --- lead_form_submissions: creación (ON CONFLICT DO NOTHING RETURNING id) ---
    if (s.indexOf('INSERT INTO lead_form_submissions (leadgen_id, page_id, form_id, ad_id, adgroup_id, estado_vinculacion)') === 0) {
      const leadgenId = params[0];
      if (estado.leadFormSubmissions.some(function(f) { return f.leadgen_id === leadgenId; })) {
        return Promise.resolve({ rows: [] }); // simula el conflicto -> DO NOTHING
      }
      const nuevo = {
        id: estado.siguienteSubmissionId++,
        leadgen_id: leadgenId, page_id: params[1], form_id: params[2],
        ad_id: params[3], adgroup_id: params[4], estado_vinculacion: 'PENDIENTE',
        field_data: [], lead_id: null
      };
      estado.leadFormSubmissions.push(nuevo);
      return Promise.resolve({ rows: [{ id: nuevo.id }] });
    }

    // --- Cualquier otra query (tablas legacy: pausados, conversaciones, etc.) ---
    // No son relevantes para lo que prueba la Fase 1A — se responde vacío/OK
    // para que el código que las llama (fire-and-forget) no explote.
    return Promise.resolve({ rows: [] });
  }

  return {
    query: query,
    _estado: estado,
    _llamadas: llamadas
  };
}

// Pequeña espera para dejar correr los `.then()`/`.catch()` de llamadas
// fire-and-forget (registrarEventoLead, actualizarTimestampLead,
// capturarReferral) que el código no encadena en la promesa que sí se espera.
function esperarMicrotareas() {
  return new Promise(function(resolve) { setTimeout(resolve, 10); });
}

module.exports = { crearPoolSimulado: crearPoolSimulado, esperarMicrotareas: esperarMicrotareas };
