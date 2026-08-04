// ═══════════════════════════════════════════════════════════════════════════
// Etapa 2, punto 2 (3 ago 2026) — cadencia de seguimiento según la intención
// de compra declarada en el formulario ("¿cuándo_te_gustaría_comprarla?",
// 4 valores confirmados con datos reales por Lili: inmediatamente,
// en_los_próximos_15_días, durante_este_mes, en_1_o_2_meses).
//
// Se prueban las dos funciones puras extraídas: detectarIntencionCompraFormulario()
// (lee el campo del formulario) y ventanaReactivacion() (mapea la intención a
// la ventana de horas del cron de reactivación 12pm/7pm — único cron que usa
// esto, solo para el estado saludo_sin_respuesta).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('detectarIntencionCompraFormulario — reconoce las 4 categorías reales confirmadas', function() {
  ['inmediatamente', 'en_los_próximos_15_días', 'durante_este_mes', 'en_1_o_2_meses'].forEach(function(valor) {
    var fieldData = [{ name: '¿cuándo_te_gustaría_comprarla?', values: [valor] }];
    assert.equal(app.detectarIntencionCompraFormulario(fieldData), valor, 'valor=' + valor);
  });
});

test('detectarIntencionCompraFormulario — ignora mayúsculas/espacios del campo y del valor', function() {
  var fieldData = [{ name: ' ¿Cuándo_Te_Gustaría_Comprarla? ', values: [' Inmediatamente '] }];
  assert.equal(app.detectarIntencionCompraFormulario(fieldData), 'inmediatamente');
});

test('detectarIntencionCompraFormulario — campo ausente devuelve null (nunca inventa)', function() {
  var fieldData = [{ name: 'nombre_completo', values: ['Deissy'] }, { name: 'phone_number', values: ['573001112233'] }];
  assert.equal(app.detectarIntencionCompraFormulario(fieldData), null);
});

test('detectarIntencionCompraFormulario — valor de respuesta desconocido (no es una de las 4 opciones) devuelve null', function() {
  var fieldData = [{ name: '¿cuándo_te_gustaría_comprarla?', values: ['algún_día_quizás'] }];
  assert.equal(app.detectarIntencionCompraFormulario(fieldData), null);
});

test('detectarIntencionCompraFormulario — field_data inválido nunca lanza excepción', function() {
  assert.equal(app.detectarIntencionCompraFormulario(null), null);
  assert.equal(app.detectarIntencionCompraFormulario(undefined), null);
  assert.equal(app.detectarIntencionCompraFormulario([]), null);
  assert.equal(app.detectarIntencionCompraFormulario([null, { name: null }]), null);
});

test('ventanaReactivacion — tiempos aprobados para las 4 categorías (en horas)', function() {
  assert.deepEqual(app.ventanaReactivacion('inmediatamente'), { minHoras: 3, maxHoras: 24 });
  assert.deepEqual(app.ventanaReactivacion('en_los_próximos_15_días'), { minHoras: 3, maxHoras: 24 });
  assert.deepEqual(app.ventanaReactivacion('durante_este_mes'), { minHoras: 48, maxHoras: 144 });
  assert.deepEqual(app.ventanaReactivacion('en_1_o_2_meses'), { minHoras: 120, maxHoras: 480 });
});

test('ventanaReactivacion — sin intención conocida usa el default (mismo comportamiento que antes de este cambio)', function() {
  assert.deepEqual(app.ventanaReactivacion(null), { minHoras: 3, maxHoras: 24 });
  assert.deepEqual(app.ventanaReactivacion(undefined), { minHoras: 3, maxHoras: 24 });
  assert.deepEqual(app.ventanaReactivacion('valor-inventado'), { minHoras: 3, maxHoras: 24 });
});

test('ventanaReactivacion — durante_este_mes y en_1_o_2_meses quedan fuera de las 24h de WhatsApp (minHoras > 24)', function() {
  assert.ok(app.ventanaReactivacion('durante_este_mes').minHoras > 24, 'requiere plantilla o notificación a Lili, no texto libre');
  assert.ok(app.ventanaReactivacion('en_1_o_2_meses').minHoras > 24, 'requiere plantilla o notificación a Lili, no texto libre');
});
