// ═══════════════════════════════════════════════════════════════════════════
// Seguimiento consciente del producto (auditoría 2 ago 2026) — antes TODOS
// los mensajes de seguimiento decían "repisa" sin importar qué producto
// pidió el lead, porque el sistema de seguimiento nació cuando Repisa
// Flotante era el único producto. getMensajeSeguimiento()/mensajeReactivacion()
// ahora reciben el producto real y generan la frase correcta (con
// concordancia de género en español); si no hay producto identificado, usan
// una frase neutra ("tu pedido") — nunca "repisa" como fallback.
//
// Regla de compatibilidad verificada aquí: con producto='Repisa Flotante',
// el texto generado debe ser BYTE-IDÉNTICO al texto hardcodeado que existía
// antes de este cambio — cero cambio de comportamiento para el único
// producto que ya estaba en producción.
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('getMensajeSeguimiento — producto Repisa Flotante genera texto idéntico al hardcodeado original', function() {
  assert.equal(
    app.getMensajeSeguimiento('saludo_sin_respuesta', 1, null, 'Repisa Flotante'),
    'Hola! 😊 ¿Pudiste pensar en la repisa? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿'
  );
  assert.equal(
    app.getMensajeSeguimiento('esperando_decision', 1, null, 'Repisa Flotante'),
    'Hola! 😊 ¿Alcanzaste a ver el espacio donde la quieres? Tengo cupo de fabricación esta semana si quieres que te la deje lista 🌿'
  );
  assert.equal(
    app.getMensajeSeguimiento('esperando_decision', 2, null, 'Repisa Flotante'),
    'Hola! 😊 Solo para no dejarte la repisa pendiente — si más adelante la quieres retomar, aquí estoy con mucho gusto 😊'
  );
  assert.equal(
    app.getMensajeSeguimiento('cotizacion_enviada', 1, null, 'Repisa Flotante'),
    'Hola! 😊 ¿Cómo te fue con la cotización de tu repisa? Si quieres ajustamos cualquier detalle (medida, fecha de entrega). Tengo cupo para arrancar esta semana 🌿'
  );
});

test('getMensajeSeguimiento — Mesa Auxiliar usa artículo/nombre femenino correctos, nunca "repisa"', function() {
  const msg = app.getMensajeSeguimiento('saludo_sin_respuesta', 1, null, 'Mesa Auxiliar');
  assert.match(msg, /la mesa auxiliar/);
  assert.doesNotMatch(msg, /repisa/i);
});

test('getMensajeSeguimiento — Escritorio Flotante usa artículo/pronombre masculino correctos ("el", "lo", "listo")', function() {
  const msgDecision = app.getMensajeSeguimiento('esperando_decision', 1, null, 'Escritorio Flotante');
  assert.match(msgDecision, /donde lo quieres/);
  assert.match(msgDecision, /te lo deje listo/);
  assert.doesNotMatch(msgDecision, /repisa/i);

  const msgCotizacion = app.getMensajeSeguimiento('cotizacion_enviada', 1, null, 'Escritorio Flotante');
  assert.match(msgCotizacion, /tu escritorio/);
});

test('getMensajeSeguimiento — producto null/desconocido usa frase neutra ("tu pedido"), nunca "repisa"', function() {
  const msg = app.getMensajeSeguimiento('saludo_sin_respuesta', 1, null, null);
  assert.match(msg, /el pedido/);
  assert.doesNotMatch(msg, /repisa/i);

  const msgDesconocido = app.getMensajeSeguimiento('cotizacion_enviada', 1, null, 'Producto Que No Existe');
  assert.match(msgDesconocido, /tu pedido/);
  assert.doesNotMatch(msgDesconocido, /repisa/i);
});

test('getMensajeSeguimiento — estados sin mención explícita de producto no cambian con el producto', function() {
  assert.equal(
    app.getMensajeSeguimiento('esperando_info', 1, null, 'Escritorio Flotante'),
    app.getMensajeSeguimiento('esperando_info', 1, null, 'Repisa Flotante')
  );
});

test('mensajeReactivacion — producto Repisa Flotante genera texto idéntico al hardcodeado original', function() {
  assert.equal(
    app.mensajeReactivacion(1, 'Repisa Flotante'),
    'Hola! 😊 ¿Pudiste pensar en la repisa? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿'
  );
});

test('mensajeReactivacion — Mesa Auxiliar nunca dice "repisa"', function() {
  const msg = app.mensajeReactivacion(1, 'Mesa Auxiliar');
  assert.match(msg, /la mesa auxiliar/);
  assert.doesNotMatch(msg, /repisa/i);
});

test('mensajeReactivacion — segundo intento es genérico y no depende del producto', function() {
  assert.equal(app.mensajeReactivacion(2, 'Mesa Auxiliar'), app.mensajeReactivacion(2, 'Repisa Flotante'));
});

test('activarSeguimiento — guarda el producto recibido', function() {
  const numero = '573001112240';
  delete app.seguimientos[numero];
  app.activarSeguimiento(numero, 'esperando_info', 'Mesa Auxiliar');
  assert.equal(app.seguimientos[numero].producto, 'Mesa Auxiliar');
  assert.equal(app.seguimientos[numero].estado, 'esperando_info');
});

test('activarSeguimiento — sin producto nuevo, conserva el producto ya conocido del número (nunca lo pierde)', function() {
  const numero = '573001112241';
  app.seguimientos[numero] = { estado: 'esperando_info', timestamp: Date.now(), intentos: 0, producto: 'Escritorio Flotante' };
  app.activarSeguimiento(numero, 'esperando_decision'); // sin tercer argumento
  assert.equal(app.seguimientos[numero].producto, 'Escritorio Flotante', 'no debe perder el producto ya conocido');
});

test('activarSeguimiento — sin producto nuevo y sin producto previo, queda null (nunca inventa "repisa")', function() {
  const numero = '573001112242';
  delete app.seguimientos[numero];
  app.activarSeguimiento(numero, 'esperando_info');
  assert.equal(app.seguimientos[numero].producto, null);
});

test('infoProductoSeguimiento — devuelve el default para producto no reconocido, nunca lanza excepción', function() {
  assert.deepEqual(app.infoProductoSeguimiento('algo-inventado'), { articulo: 'el', nombre: 'pedido', pron: 'lo', listo: 'listo' });
  assert.deepEqual(app.infoProductoSeguimiento(null), { articulo: 'el', nombre: 'pedido', pron: 'lo', listo: 'listo' });
  assert.deepEqual(app.infoProductoSeguimiento(undefined), { articulo: 'el', nombre: 'pedido', pron: 'lo', listo: 'listo' });
});
