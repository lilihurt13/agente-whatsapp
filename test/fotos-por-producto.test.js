// ═══════════════════════════════════════════════════════════════════════════
// Fotos por producto — FASE 2 (26 jul): estructura de datos y función de
// detección. Corrige el bug reportado por Lili (siempre se enviaban las
// mismas 2 fotos de repisa sin importar el producto). Estas pruebas cubren
// solo `detectarProductoParaFotos()` y `FOTOS_POR_PRODUCTO` — todavía NO
// están conectados a enviarFotosSaludo()/enviarFotosExtra() (eso es la
// Fase 3, pendiente de aprobación por separado).
// ═══════════════════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../whatsapp_agent.js');

test('FOTOS_POR_PRODUCTO — tiene los 7 productos del catálogo, cada uno con al menos 2 fotos', function() {
  const productos = [
    'Repisa Flotante', 'Escritorio Flotante', 'Mesa Auxiliar', 'Recibidor',
    'Escritorio con Cajones', 'Cama', 'Mesa de Centro con Jardinera'
  ];
  productos.forEach(function(p) {
    assert.ok(Array.isArray(app.FOTOS_POR_PRODUCTO[p]), `falta el producto "${p}"`);
    assert.ok(app.FOTOS_POR_PRODUCTO[p].length >= 2, `"${p}" debería tener al menos 2 fotos`);
    app.FOTOS_POR_PRODUCTO[p].forEach(function(url) {
      assert.ok(url.indexOf('https://res.cloudinary.com/') === 0, `URL inválida en "${p}": ${url}`);
    });
  });
});

test('FOTOS_POR_PRODUCTO — ningún producto comparte fotos con otro (sin cruce)', function() {
  const todasLasUrls = [];
  Object.keys(app.FOTOS_POR_PRODUCTO).forEach(function(producto) {
    app.FOTOS_POR_PRODUCTO[producto].forEach(function(url) { todasLasUrls.push(url); });
  });
  const unicas = new Set(todasLasUrls);
  assert.equal(unicas.size, todasLasUrls.length, 'hay URLs de fotos duplicadas entre productos distintos');
});

test('PRODUCTO_FOTOS_FALLBACK — está deshabilitado: producto ambiguo nunca usa repisas', function() {
  assert.equal(app.PRODUCTO_FOTOS_FALLBACK, null);
});

test('detectarProductoParaFotos — repisa', function() {
  assert.equal(app.detectarProductoParaFotos(['quiero ver fotos de la repisa flotante']), 'Repisa Flotante');
  assert.equal(app.detectarProductoParaFotos(['tienen estantes disponibles?']), 'Repisa Flotante');
});

test('detectarProductoParaFotos — recibidor', function() {
  assert.equal(app.detectarProductoParaFotos(['me interesa el recibidor']), 'Recibidor');
  assert.equal(app.detectarProductoParaFotos(['el banco de la entrada']), 'Recibidor');
});

test('detectarProductoParaFotos — cama', function() {
  assert.equal(app.detectarProductoParaFotos(['fotos de la cama queen']), 'Cama');
});

test('detectarProductoParaFotos — escritorio con cajones, frases específicas', function() {
  assert.equal(app.detectarProductoParaFotos(['el escritorio con cajones']), 'Escritorio con Cajones');
  assert.equal(app.detectarProductoParaFotos(['el escritorio con base']), 'Escritorio con Cajones');
  assert.equal(app.detectarProductoParaFotos(['el escritorio grande']), 'Escritorio con Cajones');
  assert.equal(app.detectarProductoParaFotos(['el de $3.200.000']), 'Escritorio con Cajones');
});

test('detectarProductoParaFotos — escritorio flotante, frases específicas', function() {
  assert.equal(app.detectarProductoParaFotos(['el escritorio flotante']), 'Escritorio Flotante');
  assert.equal(app.detectarProductoParaFotos(['el escritorio para pared']), 'Escritorio Flotante');
  assert.equal(app.detectarProductoParaFotos(['el de $1.590.000']), 'Escritorio Flotante');
});

test('detectarProductoParaFotos — "escritorio" sin calificador cae al default logueado (Escritorio Flotante)', function() {
  const logsOriginal = console.log;
  const logs = [];
  console.log = function(msg) { logs.push(msg); };
  try {
    const resultado = app.detectarProductoParaFotos(['tienen fotos del escritorio?']);
    assert.equal(resultado, 'Escritorio Flotante');
    assert.ok(logs.some(function(l) { return l.indexOf('escritorio') !== -1 && l.indexOf('default') !== -1; }),
      'debería loguear explícitamente que usó el default ambiguo');
  } finally {
    console.log = logsOriginal;
  }
});

test('detectarProductoParaFotos — mesa de centro, frases específicas', function() {
  assert.equal(app.detectarProductoParaFotos(['la mesa de centro']), 'Mesa de Centro con Jardinera');
  assert.equal(app.detectarProductoParaFotos(['la mesa jardinera']), 'Mesa de Centro con Jardinera');
  assert.equal(app.detectarProductoParaFotos(['una mesa para sala']), 'Mesa de Centro con Jardinera');
});

test('detectarProductoParaFotos — mesa auxiliar, frases específicas', function() {
  assert.equal(app.detectarProductoParaFotos(['la mesa auxiliar']), 'Mesa Auxiliar');
  assert.equal(app.detectarProductoParaFotos(['una mesa pequeña']), 'Mesa Auxiliar');
  assert.equal(app.detectarProductoParaFotos(['la mesa de noche']), 'Mesa Auxiliar');
});

test('detectarProductoParaFotos — "mesa" sin calificador cae al default logueado (Mesa Auxiliar)', function() {
  const logsOriginal = console.log;
  const logs = [];
  console.log = function(msg) { logs.push(msg); };
  try {
    const resultado = app.detectarProductoParaFotos(['me mandas fotos de la mesa?']);
    assert.equal(resultado, 'Mesa Auxiliar');
    assert.ok(logs.some(function(l) { return l.indexOf('mesa') !== -1 && l.indexOf('default') !== -1; }),
      'debería loguear explícitamente que usó el default ambiguo');
  } finally {
    console.log = logsOriginal;
  }
});

test('detectarProductoParaFotos — sin ningún producto mencionado devuelve null', function() {
  assert.equal(app.detectarProductoParaFotos(['hola, buenos días']), null);
  assert.equal(app.detectarProductoParaFotos([]), null);
  assert.equal(app.detectarProductoParaFotos([null, undefined, '']), null);
});

test('detectarProductoParaFotos — junta varios textos (ej. mensaje del cliente + contexto) antes de buscar', function() {
  assert.equal(app.detectarProductoParaFotos(['hola', 'quiero el escritorio con cajones', 'gracias']), 'Escritorio con Cajones');
});

test('detectarProductoParaFotos — es independiente de detectarProductoPorTexto (no se tocó el cotizador)', function() {
  // Escritorio con Cajones no es un producto que exista en el cotizador de
  // repisas (esa función solo conoce Repisa/Mesa Auxiliar/Escritorio
  // Flotante) — confirma que esta es una función y tabla separadas.
  assert.equal(app.detectarProductoPorTexto(['escritorio con cajones']), 'Escritorio Flotante');
  assert.equal(app.detectarProductoParaFotos(['escritorio con cajones']), 'Escritorio con Cajones');
});

// ─── FASE 3 (26 jul) — selección de fotos y envío product-aware ───────────

test('fotosParaProducto — devuelve las fotos propias de cada producto', function() {
  Object.keys(app.FOTOS_POR_PRODUCTO).forEach(function(producto) {
    assert.deepEqual(app.fotosParaProducto(producto), app.FOTOS_POR_PRODUCTO[producto]);
  });
});

test('fotosParaProducto — producto desconocido/null no devuelve fotos de sustitución', function() {
  assert.deepEqual(app.fotosParaProducto('Producto Inexistente'), []);
  assert.deepEqual(app.fotosParaProducto(null), []);
  assert.deepEqual(app.fotosParaProducto(undefined), []);
});

test('seleccionarFotosSaludo — usa las primeras 2 fotos del producto', function() {
  assert.deepEqual(app.seleccionarFotosSaludo(app.FOTOS_POR_PRODUCTO['Repisa Flotante']), [
    app.FOTOS_POR_PRODUCTO['Repisa Flotante'][0],
    app.FOTOS_POR_PRODUCTO['Repisa Flotante'][1]
  ]);
});

test('seleccionarFotosSaludo — producto con una sola foto repite esa misma (no rompe)', function() {
  assert.deepEqual(app.seleccionarFotosSaludo(['unica.png']), ['unica.png', 'unica.png']);
});

test('seleccionarFotosExtra — con 3+ fotos usa la 2ª y 3ª (distintas a las del saludo)', function() {
  var fotosRepisa = app.FOTOS_POR_PRODUCTO['Repisa Flotante'];
  assert.equal(fotosRepisa.length, 3, 'este caso asume que Repisa Flotante tiene 3 fotos');
  var saludo = app.seleccionarFotosSaludo(fotosRepisa);
  var extra = app.seleccionarFotosExtra(fotosRepisa);
  assert.deepEqual(extra, [fotosRepisa[1], fotosRepisa[2]]);
  assert.equal(saludo.indexOf(extra[1]), -1, 'la 3ª foto de extra no debería haberse mostrado ya en el saludo');
});

test('seleccionarFotosExtra — con exactamente 2 fotos, se repiten (no hay más disponibles)', function() {
  var fotosMesaAuxiliar = app.FOTOS_POR_PRODUCTO['Mesa Auxiliar'];
  assert.equal(fotosMesaAuxiliar.length, 2, 'este caso asume que Mesa Auxiliar tiene 2 fotos');
  assert.deepEqual(app.seleccionarFotosExtra(fotosMesaAuxiliar), fotosMesaAuxiliar);
});

test('Fase 3 — ningún producto termina mostrando fotos de otro producto (saludo + extra combinados)', function() {
  Object.keys(app.FOTOS_POR_PRODUCTO).forEach(function(producto) {
    var fotos = app.FOTOS_POR_PRODUCTO[producto];
    var mostradas = app.seleccionarFotosSaludo(fotos).concat(app.seleccionarFotosExtra(fotos));
    mostradas.forEach(function(url) {
      assert.ok(fotos.indexOf(url) !== -1, `"${producto}" mostró una foto que no le pertenece: ${url}`);
      Object.keys(app.FOTOS_POR_PRODUCTO).forEach(function(otro) {
        if (otro === producto) return;
        assert.equal(app.FOTOS_POR_PRODUCTO[otro].indexOf(url), -1,
          `"${producto}" mostró una foto de "${otro}": ${url}`);
      });
    });
  });
});

test('solicitudExplicitaFotos — "Sala" no autoriza fotos aunque Claude agregue el tag', function() {
  assert.equal(app.solicitudExplicitaFotos('Sala', []), false);
});

test('solicitudExplicitaFotos — petición directa sí autoriza fotos', function() {
  assert.equal(app.solicitudExplicitaFotos('¿Me mandas fotos de la mesa?', []), true);
  assert.equal(app.solicitudExplicitaFotos('Quiero ver cómo queda', []), true);
});

test('solicitudExplicitaFotos — "Sí" solo autoriza si responde a una pregunta explícita sobre fotos', function() {
  assert.equal(app.solicitudExplicitaFotos('Sí', [
    { role: 'assistant', content: '¿Te gustaría verla en fotos o tienes alguna duda sobre las medidas?' }
  ]), true);
  assert.equal(app.solicitudExplicitaFotos('Sí', [
    { role: 'assistant', content: '¿La estás pensando para la sala o la habitación?' }
  ]), false);
});

test('solicitudFotoDetalleEspecifico — distingue un detalle inexistente de una petición general', function() {
  assert.equal(app.solicitudFotoDetalleEspecifico('¿Tienes una foto del cajón por dentro?'), true);
  assert.equal(app.solicitudFotoDetalleEspecifico('Muéstrame otro ángulo de los soportes'), true);
  assert.equal(app.solicitudFotoDetalleEspecifico('¿Me mandas más fotos?'), false);
});

test('resolverProductoParaFotos — caso real: "Sí" conserva Mesa Auxiliar desde el historial', function() {
  var historial = [
    { role: 'user', content: 'Mesas pequeñas o mesitas de centro pequeños' },
    { role: 'assistant', content: 'Tenemos la mesa auxiliar que es perfecta para esos espacios.' },
    { role: 'user', content: 'Sala' },
    { role: 'assistant', content: '¿Te gustaría verla en fotos?' },
    { role: 'user', content: 'Si' }
  ];
  assert.equal(app.resolverProductoParaFotos({
    textoActual: 'Si',
    respuestaClaude: '¡Claro! Aquí te muestro cómo queda 😊 [FOTOS_EXTRA]',
    historial: historial,
    productoPersistido: null
  }), 'Mesa Auxiliar');
});

test('resolverProductoParaFotos — producto persistido gana sobre menciones antiguas del historial', function() {
  assert.equal(app.resolverProductoParaFotos({
    textoActual: '¿Tienes otra foto?',
    respuestaClaude: 'Claro',
    historial: [{ role: 'assistant', content: 'También fabricamos repisas.' }],
    productoPersistido: 'Mesa Auxiliar'
  }), 'Mesa Auxiliar');
});

test('resolverProductoParaFotos — caso real 573207629644: referral de Mesa Auxiliar gana aunque saludo solo diga compacta/clásica', function() {
  assert.equal(app.resolverProductoParaFotos({
    textoActual: '¡Hola! Quiero más información',
    respuestaClaude: '¿Cuál de los dos tamaños te llama más la atención? La compacta de 35×45cm o la clásica de 45×45cm.',
    historial: [],
    productoContextoOrigen: 'Mesa Auxiliar',
    productoPersistido: null
  }), 'Mesa Auxiliar');
});

test('resolverProductoParaFotos — el producto explícito actual puede cambiar el producto del referral', function() {
  assert.equal(app.resolverProductoParaFotos({
    textoActual: 'En realidad quiero ver el escritorio flotante',
    respuestaClaude: '',
    historial: [],
    productoContextoOrigen: 'Mesa Auxiliar',
    productoPersistido: 'Mesa Auxiliar'
  }), 'Escritorio Flotante');
});

test('resolverProductoParaFotos — cambio explícito actualiza el producto activo', function() {
  assert.equal(app.resolverProductoParaFotos({
    textoActual: 'Mejor muéstrame la repisa flotante',
    respuestaClaude: '',
    historial: [{ role: 'assistant', content: 'Hablábamos de la mesa auxiliar.' }],
    productoPersistido: 'Mesa Auxiliar'
  }), 'Repisa Flotante');
});

test('resolverProductoParaFotos — sin contexto confiable devuelve null, nunca repisa', function() {
  assert.equal(app.resolverProductoParaFotos({
    textoActual: 'Sí',
    respuestaClaude: 'Claro',
    historial: [],
    productoPersistido: null
  }), null);
});

test('getSystemPrompt — prohíbe ofrecer fotos adicionales por iniciativa propia', function() {
  var prompt = app.getSystemPrompt();
  assert.ok(prompt.indexOf('NUNCA ofrezcas fotos adicionales por iniciativa propia') !== -1);
  assert.ok(prompt.indexOf('cuando el cliente las pida explícitamente') !== -1);
});
