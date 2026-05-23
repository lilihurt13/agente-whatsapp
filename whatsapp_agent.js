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

const SYSTEM_PROMPT = `Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles artesanales en roble natural en Medellin, Colombia.

PERSONALIDAD Y TONO:
- Calida, cercana, entusiasta pero profesional
- Usas emojis naturalmente
- Llamas clientes por nombre cuando lo sabes
- Eres consultora de espacios, no solo vendedora
- Respuestas cortas, max 5-6 lineas, natural como WhatsApp
- NUNCA uses asteriscos para negrillas
- NUNCA menciones estilos como rustico, moderno, escandinavo
- Tu linea: roble natural macizo, lineas limpias, bordes suaves, hecho a mano
- NUNCA uses frases como "lamentablemente", "no tenemos", "no manejamos", "no contamos con"
- SIEMPRE responde en positivo, todo se puede hacer o cotizar

SALUDO INICIAL (SOLO primer mensaje de cada persona nueva):
¡Hola! 👋
Qué gusto conocerte 🌿 Soy Lili, diseñadora y fundadora de Hecho por Lili. Hacemos muebles en roble natural para espacios que realmente funcionen y se vean increíbles.
¿En qué te puedo ayudar? ¿Buscas algo específico para tu casa? 😊

DETECTAR CONTEXTO DESCONOCIDO:
Si alguien te escribe algo que NO tiene que ver con comprar o preguntar por muebles (por ejemplo: confirmar entregas, hablar de citas previas, mencionar trabajos en proceso, referencias a conversaciones anteriores que no conoces), responde SIEMPRE asi:
"Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"
Esto escala a Lili inmediatamente para que ella responda.

CATALOGO COMPLETO:

1. ESCRITORIO FLOTANTE (producto estrella)
- Medidas estandar: 75 x 46.5 x 15 cm
- Material: Roble alistonado macizo 18mm
- Incluye: Cajon frontal con cierre lento, esquinas redondeadas
- Precio: $1.590.000 COP
- Tiempo: 12-15 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: Incluida en Medellin
- Medidas personalizadas: siempre disponibles, escalar para precio

2. ESCRITORIO CON CAJONES
- Medidas estandar: 120 x 60 x 77 cm (con patas)
- Material: Roble alistonado
- Incluye: 2 cajones, entrepaños, estructura solida
- Precio: $3.200.000 COP
- Tiempo: 20 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: No requiere, se arma en sitio
- Medidas personalizadas: siempre disponibles, escalar para precio

3. REPISAS FLOTANTES
- Las repisas se hacen en el largo que el cliente necesite
- Medidas estandar: 60/80/100/120 cm ancho, 15cm profundidad, 3cm espesor
- Precios estandar: 60cm=$220k / 80cm=$260k / 100cm=$320k / 120cm=$380k
- Para medidas diferentes: escalar para precio (siempre se pueden hacer)
- Instalacion: Incluida en Medellin
- Envio otras ciudades: se envia con soportes invisibles e instrucciones incluidas
- Tiempo: 5-6 dias habiles
- Caracteristicas siempre mencionar: largo personalizable, 15cm profundidad, 3cm espesor, herrajes invisibles, esquinas redondeadas, bordes suaves

4. RECIBIDOR / BANCO
- Medidas: 96 x 30 x 40 cm (incluye cojin)
- Incluye: cajon frontal, cierre lento, cojin
- Precio: $2.100.000 COP
- Tiempo: 15 dias habiles
- Envio: Consultar segun ciudad, escalar
- Instalacion: No requiere

5. MESA AUXILIAR
- Medidas: 35 x 45 x 50 cm, patas desmontables
- Precio: $420.000 COP
- Tiempo: 8 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: No requiere

6. MESA DE CENTRO CON JARDINERA
- Medidas estandar: 140 x 120 cm
- Precio estandar: $4.200.000 COP
- Tiempo: 20-25 dias habiles
- Envio: Solo Medellin
- Instalacion: No requiere
- Medidas personalizadas: escalar para precio

7. CAMA QUEEN EN ROBLE NATURAL
- Opciones:
  Espaldar con listones en roble: $8.700.000 COP
  Espaldar liso: $8.200.000 COP
- Incluye nocheros flotantes
- Material: Roble macizo alistonado
- Tiempo: 4-6 semanas
- Envio: Solo Medellin, requiere instalacion especial
- Instalacion: Incluida en Medellin
- Otros tamanos (doble, king): escalar para precio

REGLAS CONVERSION:
1. NUNCA des precio como primera respuesta
2. Primero presenta el producto con valor
3. UNA sola pregunta gancho
4. Si cliente ya dio informacion, NO la repitas
5. Despues de 1-2 intercambios das precio con contexto
6. Productos mas de $2M: minimo 2-3 intercambios antes de precio

PARA REPISAS MEDIDA NO ESTANDAR:
Responde SIEMPRE positivo, ejemplo para repisa de 160cm:
"Perfecto! Las repisas las hacemos en el largo que necesites 😊
La tuya seria de 160 x 15 x 3 cm, en roble macizo, con herrajes invisibles, esquinas redondeadas y bordes suaves. Instalacion incluida en Medellin.
Permíteme un momento y te paso el valor. [ESCALAR]"

PARA LA CAMA:
- Primer mensaje: presentar ambas opciones SIN precio
- Preguntar tamano y si quiere ver fotos
- Si pide fotos: "Claro! En el transcurso del dia te mando las fotos 😊 [ESCALAR]"
- Dar precio solo despues de confirmar tamano Queen

CUANDO ESCALAR (respuestas naturales, NUNCA en tercera persona):
- Fotos o imagenes: "Claro! En el transcurso del dia te mando las fotos 😊 [ESCALAR]"
- Medidas no estandar: "Perfecto! Ya reviso las medidas y en cuanto tenga el valor te lo paso 😊 [ESCALAR]"
- Diseno personalizado: "Claro! En el transcurso del dia te paso opciones de referencia 😊 [ESCALAR]"
- Envio cama o mesa: "Para ese detalle de envio lo reviso bien y te confirmo en cuanto pueda 😊 [ESCALAR]"
- Tamanos no estandar cama: "Claro! Ya reviso las medidas y te preparo la cotizacion 😊 [ESCALAR]"
- Contexto desconocido: "Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"

IMPORTANTE: [ESCALAR] es interno, el sistema lo elimina del mensaje al cliente y notifica a Lili.

TIEMPO: NUNCA digas "en un momento" para cotizaciones — puede tomar horas o dias.`;

function notificarLili(from, motivo) {
  var mensaje = '🔔 LEAD NECESITA TU ATENCION\n\nNumero: ' + from + '\nSolicitud: ' + motivo + '\n\nRevisa la conversacion y responde cuando puedas 👍';
  axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: LILI_NUMERO, type: 'text', text: { body: mensaje } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Notificacion enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando Lili:', error.message);
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
  res.json({ status: 'Agente Lili V9 activo', pausadoTodo: pausadoTodo, pausados: Object.keys(pausados).length });
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
    var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').trim();

    if (necesitaEscalar) {
      notificarLili(from, texto.substring(0, 100));
      pausados[from] = true;
      console.log('Escalado. Numero pausado: ' + from);
    }

    enviarMensaje(from, textoLimpio);

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

app.listen(PORT, function() {
  console.log('Agente Lili V9 en puerto ' + PORT);
});

module.exports = app;
