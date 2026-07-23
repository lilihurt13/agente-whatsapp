// ═══════════════════════════════════════════════════════════════════════════
// Fase 1B — formulario de Lead Ads → personalización del primer mensaje.
// Mismo límite documentado en docs/PHASE_1A_TESTING.md: pool simulado a
// mano, valida orquestación en JS, no semántica real de SQL.
//
// NOTA DE ALCANCE: no se prueba aquí procesarMensaje() de punta a punta
// (requeriría mockear axios contra Anthropic/Meta, no incluido en esta
// pasada) — se prueban las piezas nuevas que sí son puramente de esta fase:
// la búsqueda del formulario vinculado (con la ventana de 48h) y el
// formateo/detección de producto.
// ═══════════════════════════════════════════════════════════════════════════

process.env.CONTROL_TOKEN = process.env.CONTROL_TOKEN || 'token-de-prueba-fase1a';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crearPoolSimulado } = require('./helpers/fakePool');
const app = require('../whatsapp_agent.js');

function poolFresco() {
  const p = crearPoolSimulado();
  app.__setPoolParaPruebas(p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// detectarProductoFormulario
// ─────────────────────────────────────────────────────────────────────────
test('detectarProductoFormulario — reconoce Repisa por el nombre del campo', function() {
  const producto = app.detectarProductoFormulario([
    { name: 'donde_necesitas_la_repisa', values: ['Medellín'] },
    { name: 'largo', values: ['80cm'] }
  ]);
  assert.equal(producto, 'Repisa Flotante');
});

test('detectarProductoFormulario — reconoce Mesa Auxiliar por el valor elegido (Compacta/Clásica)', function() {
  const producto = app.detectarProductoFormulario([
    { name: 'que_version_te_interesa', values: ['Compacta 35×45×50cm $390.000'] },
    { name: 'donde_la_necesitas', values: ['Medellín'] }
  ]);
  assert.equal(producto, 'Mesa Auxiliar');
});

test('detectarProductoFormulario — reconoce Escritorio por el nombre del campo', function() {
  const producto = app.detectarProductoFormulario([
    { name: 'donde_necesitas_el_escritorio', values: ['Área Metropolitana'] }
  ]);
  assert.equal(producto, 'Escritorio Flotante');
});

test('detectarProductoFormulario — sin coincidencia conocida devuelve null (no rompe)', function() {
  const producto = app.detectarProductoFormulario([
    { name: 'pregunta_desconocida', values: ['algo'] }
  ]);
  assert.equal(producto, null);
});

// ─────────────────────────────────────────────────────────────────────────
// formatearRespuestasFormulario
// ─────────────────────────────────────────────────────────────────────────
test('formatearRespuestasFormulario — formatea respuestas y excluye teléfono/nombre', function() {
  const bloque = app.formatearRespuestasFormulario({
    field_data: [
      { name: 'full_name', values: ['Juan Pérez'] },
      { name: 'phone_number', values: ['573001234567'] },
      { name: 'donde_necesitas_el_escritorio', values: ['Medellín'] },
      { name: 'medida_estandar', values: ['Sí esa medida me funciona'] },
      { name: 'cuando', values: ['Inmediatamente'] }
    ]
  });

  assert.ok(bloque.indexOf('Escritorio Flotante') !== -1, 'debe incluir el producto detectado en el encabezado');
  assert.ok(bloque.indexOf('Juan Pérez') === -1, 'no debe incluir el nombre');
  assert.ok(bloque.indexOf('573001234567') === -1, 'no debe incluir el teléfono');
  assert.ok(bloque.indexOf('Medellín') !== -1);
  assert.ok(bloque.indexOf('Inmediatamente') !== -1);
});

test('formatearRespuestasFormulario — sin field_data devuelve null', function() {
  assert.equal(app.formatearRespuestasFormulario({ field_data: [] }), null);
  assert.equal(app.formatearRespuestasFormulario({ field_data: null }), null);
});

// ─────────────────────────────────────────────────────────────────────────
// obtenerFormularioVinculadoReciente
// ─────────────────────────────────────────────────────────────────────────
test('obtenerFormularioVinculadoReciente — devuelve el formulario si está VINCULADO y dentro de 48h', async function() {
  const pool = poolFresco();
  pool._estado.leadFormSubmissions.push({
    id: 1, leadgen_id: 'LG-B1', lead_id: 42, estado_vinculacion: 'VINCULADO',
    field_data: [{ name: 'donde_necesitas_la_repisa', values: ['Medellín'] }],
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000) // hace 2 horas
  });

  const resultado = await app.obtenerFormularioVinculadoReciente(42);
  assert.ok(resultado, 'debe encontrar el formulario');
  assert.equal(resultado.leadgen_id, 'LG-B1');
});

test('obtenerFormularioVinculadoReciente — ignora formularios fuera de la ventana de 48h', async function() {
  const pool = poolFresco();
  pool._estado.leadFormSubmissions.push({
    id: 2, leadgen_id: 'LG-B2', lead_id: 43, estado_vinculacion: 'VINCULADO',
    field_data: [],
    created_at: new Date(Date.now() - 72 * 60 * 60 * 1000) // hace 72 horas — fuera de ventana
  });

  const resultado = await app.obtenerFormularioVinculadoReciente(43);
  assert.equal(resultado, null, 'no debe devolver un formulario de hace 72h');
});

test('obtenerFormularioVinculadoReciente — ignora formularios PENDIENTE/FALLIDO', async function() {
  const pool = poolFresco();
  pool._estado.leadFormSubmissions.push({
    id: 3, leadgen_id: 'LG-B3', lead_id: 44, estado_vinculacion: 'PENDIENTE',
    field_data: [], created_at: new Date()
  });

  const resultado = await app.obtenerFormularioVinculadoReciente(44);
  assert.equal(resultado, null, 'un formulario PENDIENTE no debe usarse para personalizar');
});

test('obtenerFormularioVinculadoReciente — sin leadId devuelve null sin consultar', async function() {
  poolFresco();
  const resultado = await app.obtenerFormularioVinculadoReciente(null);
  assert.equal(resultado, null);
});

test('obtenerFormularioVinculadoReciente — lead sin ningún formulario devuelve null', async function() {
  poolFresco();
  const resultado = await app.obtenerFormularioVinculadoReciente(999);
  assert.equal(resultado, null);
});
