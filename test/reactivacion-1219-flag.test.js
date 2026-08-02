// ═══════════════════════════════════════════════════════════════════════════
// Feature flag REACTIVACION_12_19_ENABLED (2 ago 2026) — agregado tras el
// incidente donde cmd=todo en /control vació la tabla `pausados` por
// completo. Mismo patrón exacto que cotizadorRepisasV2Habilitado(): por
// defecto (variable ausente o distinta de 'true') el cron de reactivación
// de 12pm/7pm no envía nada — apagado hasta que se corrija el resto del
// sistema de seguimiento (texto "repisa" hardcodeado para cualquier
// producto, ver docs/PENDIENTES.md).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('reactivacion1219Habilitada — por defecto (variable ausente) está apagada', function() {
  var original = process.env.REACTIVACION_12_19_ENABLED;
  delete process.env.REACTIVACION_12_19_ENABLED;
  assert.equal(app.reactivacion1219Habilitada(), false);
  if (original !== undefined) process.env.REACTIVACION_12_19_ENABLED = original;
});

test('reactivacion1219Habilitada — valores distintos de "true" siguen apagada', function() {
  var original = process.env.REACTIVACION_12_19_ENABLED;
  ['false', 'TRUE', '1', 'si', ''].forEach(function(valor) {
    process.env.REACTIVACION_12_19_ENABLED = valor;
    assert.equal(app.reactivacion1219Habilitada(), false, 'valor=' + JSON.stringify(valor));
  });
  if (original === undefined) delete process.env.REACTIVACION_12_19_ENABLED;
  else process.env.REACTIVACION_12_19_ENABLED = original;
});

test('reactivacion1219Habilitada — "true" exacto la activa', function() {
  var original = process.env.REACTIVACION_12_19_ENABLED;
  process.env.REACTIVACION_12_19_ENABLED = 'true';
  assert.equal(app.reactivacion1219Habilitada(), true);
  if (original === undefined) delete process.env.REACTIVACION_12_19_ENABLED;
  else process.env.REACTIVACION_12_19_ENABLED = original;
});
