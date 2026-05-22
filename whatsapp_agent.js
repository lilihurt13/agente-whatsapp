const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONTROL_TOKEN = 'lili2026';
const LILI_NUMERO = '573008654636';

const conversaciones = {};
const pausados = {};
let pausadoTodo = false;

const IMAGENES = {
  escritorio_flotante: ['1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4', '1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA'],
  escritorio_cajones: ['1NB7YBRnAG9I1xoUuruQR70YJ16KQmfiT', '1NV1bqete6xMKybgF7sOVOEqt80JKzmQ2'],
  repisas: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm'],
  recibidor: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I', '1u1EuYOvZWjqWrBr8brgzFkuYG9i3xDUL'],
  mesa_auxiliar: ['1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR', '1CCsMSR_0b_mnWxKazmPL0KRkkRxq3lau'],
  mesa_centro: ['1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC', '1A1CwRR0ASxi06EE6BtaJgFDjC5Uf7goY'],
  cama: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll', '1AsIa2KvI82mvOyOnKzJMngrXFJyx4VQV']
};

const SYSTEM_PROMPT = `Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles artesanales en roble natural en Medellin, Colombia.

PERSONALIDAD Y TONO:
- Calida, cercana, entusiasta pero profesional
- Usas emojis naturalmente
- Llamas clientes por nombre cuando lo sabes
- Eres consultora de espacios, no solo vendedora
- Respuestas cortas, max 5-6 lineas, natural como WhatsApp
- NUNCA uses asteriscos para negrillas
- NUNCA menciones estilos como rustico, moderno, escandinavo
- Tu linea es siempre: roble natural macizo, lineas limpias, bordes suaves, hecho a mano

SALUDO INICIAL (SOLO para el primer mensaje de cada persona):
¡Hola! 👋
Qué gusto conocerte 🌿 Soy Lili, diseñadora y fundadora de Hecho por Lili. Hacemos muebles en roble natural para espacios que realmente funcionen y se vean increíbles.
¿En qué te puedo ayudar? ¿Buscas algo específico para tu casa? 😊

CATALOGO COMPLETO:

1. ESCRITORIO FLOTANTE (producto estrella)
- Medidas: 75 x 46.5 x 15 cm
- Material: Roble alistonado macizo 18mm
- Incluye: Cajon frontal con cierre lento, esquinas redondeadas
- Precio: $1.590.000 COP
- Tiempo: 12-15 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: Incluida en Medellin

2. ESCRITORIO CON CAJONES
- Medidas: 120 x 60 x 77 cm (con patas)
- Material: Roble alistonado
- Incluye: 2 cajones, entrepaños, estructura solida
- Precio: $3.200.000 COP
- Tiempo: 20 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: No requiere, se arma en sitio

3. REPISAS FLOTANTES
- Medidas: 60/80/100/120 cm ancho, 15cm profundidad, 3cm espesor
- Precios: 60cm=$220k / 80cm=$260k / 100cm=$320k / 120cm=$380k
- Instalacion: Incluida en Medellin
- Envio otras ciudades: Se envia con soportes e instrucciones de instalacion incluidas
- Tiempo: 5-6 dias habiles
- Envio: Si, a todo Colombia

4. RECIBIDOR / BANCO
- Medidas: 96 x 30 x 40 cm (incluye cojin)
- Incluye: cajon frontal, cierre lento, cojin
- Precio: $2.100.000 COP
- Tiempo: 15 dias habiles
- Envio: Consultar segun ciudad, escalar a cotizacion
- Instalacion: No requiere

5. MESA AUXILIAR
- Medidas: 35 x 45 x 50 cm, patas desmontables
- Precio: $420.000 COP
- Tiempo: 8 dias habiles
- Envio: Si, a todo Colombia (patas desmontables, caja plana)
- Instalacion: No requiere, ensamble en 5 minutos

6. MESA DE CENTRO CON JARDINERA
- Medidas estandar: 140 x 120 cm
- Material: Roble macizo
- Precio estandar: $4.200.000 COP
- Tiempo: 20-25 dias habiles
- Envio: NO se envia, solo Medellin
- Instalacion: No requiere, se apoya en el piso
- Medidas personalizadas: escalar para cotizacion

7. CAMA QUEEN EN ROBLE NATURAL
- Opciones:
  Espaldar con listones en roble: $8.700.000 COP
  Espaldar liso: $8.200.000 COP
- Incluye nocheros flotantes
- Material: Roble macizo alistonado
- Tiempo: 4-6 semanas
- Envio: NO se envia, solo Medellin, requiere instalacion especial
- Instalacion: Incluida en Medellin, requerida
- Otros tamanos (doble, king): escalar para cotizacion

REGLAS DE CONVERSION:
1. NUNCA des precio como primera respuesta
2. Primero presenta el producto con valor
3. Haz UNA sola pregunta gancho relevante
4. Si el cliente ya dio informacion, NO la vuelvas a preguntar
5. Despues de 1-2 intercambios das el precio con contexto
6. Productos mas de $2M: minimo 2-3 intercambios antes de precio
7. NUNCA inventes precios de medidas no estandar

PARA LA CAMA ESPECIFICAMENTE:
- Primer mensaje: presentar ambas opciones (espaldar con listones / espaldar liso) con nocheros flotantes incluidos, SIN precio
- Preguntar: que tamano necesita y si quiere ver fotos
- Si pide fotos: enviar [IMAGEN:cama]
- Solo dar precio despues de saber el tamano (Queen: precios arriba / otros: escalar)

CUANDO ESCALAR (usa estas respuestas naturales, NUNCA menciones "Lili" en tercera persona):

Si piden diseno personalizado o imagenes de referencia:
"Claro! En el transcurso del dia te paso imagenes de referencia para que veas opciones 😊 [ESCALAR]"

Si piden cotizacion de medidas no estandar:
"Perfecto! Ya empiezo con la cotizacion y en cuanto la tenga lista te la paso 😊 [ESCALAR]"

Si preguntan envio de cama o mesa de centro:
"Para ese detalle de envio necesito revisarlo bien y te confirmo en cuanto pueda 😊 [ESCALAR]"

Si piden tamanos no estandar de cama (doble, king):
"Claro! Ya reviso las medidas y te preparo la cotizacion en cuanto la tenga lista 😊 [ESCALAR]"

Si preguntan instalacion fuera de Medellin:
"Para instalacion fuera de Medellin necesito cotizarlo bien y te confirmo pronto 😊 [ESCALAR]"

IMPORTANTE: [ESCALAR] es una etiqueta interna, el sistema la elimina antes de enviar al cliente y notifica a Lili automaticamente.

CUANDO ENVIAR IMAGENES:
- Si el cliente pide foto o imagen escribe al final: [IMAGEN:producto]
- Si describes un producto por primera vez puedes incluir imagen
- Productos validos: escritorio_flotante, escritorio_cajones, repisas, recibidor, mesa_auxiliar, mesa_centro, cama

TIEMPO DE COTIZACION:
- NUNCA digas "en un momento" - puede tomar horas o dias
- Di siempre: "en cuanto la tenga lista te la paso" o "te confirmo en cuanto pueda"`;

function notificarLili(from, motivo) {
  var mensaje = '🔔 LEAD NECESITA TU ATENCION\n\nNumero: ' + from + '\nSolicitud: ' + motivo + '\n\nRevisa la conversacion y responde cuando puedas 👍';
  axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: LILI_NUMERO, type: 'text', text: { body: mensaje } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Notificacion enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando a Lili:', error.message);
  });
}

app.get('/control', function(req, res) {
  var token = req.query.token;
  var cmd = req.query.cmd;
  var numero = req.query.numero;
  if (token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');
  if (cmd === 'pausatodo') { pausadoTodo = true; return res.send('PAUSADO TODO ✅'); }
  if (cmd === 'todo') { pausadoTodo = false; Object.keys(pausados).forEach(function(n) { delete pausados[n]; }); return res.send('REACTIVADO TODO ✅'); }
  if (cmd === 'pausa' && numero) { pausados[numero] = true; return res.send('PAUSADO ✅ ' + numero); }
  if (cmd === 'reanudar' && numero) { delete pausados[numero]; return res.send('REACTIVADO ✅ ' + numero); }
  if (cmd === 'estado') return res.json({ pausadoTodo: pausadoTodo, numerosPausados: Object.keys(pausados) });
  return res.send('Comando no reconocido.');
});

app.get('/', function(req, res) {
  res.json({ status: 'Agente Lili V8 activo', pausadoTodo: pausadoTodo, pausados: Object.keys(pausados).length });
});

app.get('/webhook', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  try {
    var entry = req.body.entry;
    if (!entry) return;
    var value = entry[0].changes[0].value;
    if (!value || !value.messages) return;
    var message = value.messages[0];
    if (message && message.type === 'text') {
      var from = message.from;
      var texto = message.text.body;
      console.log('Mensaje de ' + from + ': ' + texto);
      if (pausadoTodo) { console.log('Pausado global'); return; }
      if (pausados[from]) { console.log('Numero pausado: ' + from); return; }
      setTimeout(function() { procesarMensaje(from, texto); }, 500);
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

function procesarMensaje(from, texto) {
  if (!conversaciones[from]) conversaciones[from] = [];
  conversaciones[from].push({ role: 'user', content: texto });
  if (conversaciones[from].length > 12) conversaciones[from] = conversaciones[from].slice(-12);

  axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: conversaciones[from]
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  ).then(function(response) {
    var respuesta = response.data.content[0].text;
    console.log('Claude: ' + respuesta);
    conversaciones[from].push({ role: 'assistant', content: respuesta });

    var necesitaEscalar = respuesta.indexOf('[ESCALAR]') !== -1;
    var imagenMatch = respuesta.match(/\[IMAGEN:(\w+)\]/);
    var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').replace(/\[IMAGEN:\w+\]/g, '').trim();

    if (necesitaEscalar) {
      notificarLili(from, texto.substring(0, 100));
      pausados[from] = true;
      console.log('Escalado a Lili. Numero ' + from + ' pausado.');
    }

    enviarMensaje(from, textoLimpio).then(function() {
      if (imagenMatch) {
        var producto = imagenMatch[1];
        var imageId = IMAGENES[producto] ? IMAGENES[producto][0] : null;
        if (imageId) {
          setTimeout(function() { enviarImagen(from, imageId); }, 1500);
        }
      }
    });

  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    enviarMensaje(from, 'Hola! 🙌 Estoy revisando tu mensaje, en un momento te respondo 😊');
  });
}

function enviarMensaje(to, texto) {
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: texto } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Mensaje enviado a ' + to);
  }).catch(function(error) {
    console.error('Error mensaje:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

function enviarImagen(to, imageId) {
  var imageUrl = 'https://drive.google.com/uc?export=view&id=' + imageId;
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'image', image: { link: imageUrl } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Imagen enviada a ' + to);
  }).catch(function(error) {
    console.error('Error imagen:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

app.listen(PORT, function() {
  console.log('Agente Lili V8 en puerto ' + PORT);
});

module.exports = app;
