const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const conversaciones = {};

const IMAGENES = {
  escritorio_flotante: ['1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4', '1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA'],
  repisas: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm'],
  recibidor: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I'],
  mesa_auxiliar: ['1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR'],
  mesa_centro: ['1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC'],
  cama: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll']
};

const SYSTEM_PROMPT = "Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles en roble natural en Medellin, Colombia.\n\nPERSONALIDAD:\n- Calida, cercana, entusiasta pero profesional\n- Usas emojis naturalmente\n- Llamas clientes por nombre cuando lo sabes\n- Eres consultora, no solo vendedora\n\nPRODUCTOS:\n1. Escritorio Flotante: 75x46.5x15 cm | $1.590.000 | 12-15 dias | Cajon cierre lento, esquinas redondeadas, instalacion incluida Medellin\n2. Repisas: 60cm $220k / 80cm $260k / 100cm $320k / 120cm $380k | 5-6 dias | 15cm profundidad, soportes invisibles\n3. Recibidor/Banco: 96x30x40 cm | $2.100.000 | 15 dias | Cajon + cojin\n4. Mesa Auxiliar: 35x45x50 cm | $420.000 | 8 dias | Patas desmontables\n5. Mesa de Centro con Jardinera: 140x120 cm | $4.200.000 | 20-25 dias\n6. Cama Queen listonada: $8.700.000 | Cama Queen lisa: $8.200.000 | 4-6 semanas\n\nREGLAS:\n- Siempre: 1) Responde claro 2) Agrega valor 3) Haz pregunta gancho\n- Productos +$2M: minimo 2-3 intercambios ANTES de dar precio\n- NUNCA justifiques precio, comunica valor\n- Si piden imagen escribe al final exactamente: [IMAGEN:producto] donde producto es: escritorio_flotante, repisas, recibidor, mesa_auxiliar, mesa_centro, cama\n- Material siempre: Roble alistonado MACIZO (no MDF, no aglomerado)\n- Instalacion Medellin incluida en escritorio. Repisas opcional $30k-$50k adicional\n- Envios a todo Colombia\n\nRespuestas cortas (max 5-6 lineas), natural como WhatsApp, solo en español.";

app.get('/', function(req, res) {
  res.json({ status: 'Agente Lili V5 con Claude AI activo' });
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
    var changes = entry[0].changes;
    if (!changes) return;
    var value = changes[0].value;
    if (!value) return;
    var messages = value.messages;
    if (!messages) return;
    var message = messages[0];
    if (message && message.type === 'text') {
      var from = message.from;
      var texto = message.text.body;
      console.log('Mensaje de ' + from + ': ' + texto);
      setTimeout(function() {
        procesarMensaje(from, texto);
      }, 500);
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

function procesarMensaje(from, texto) {
  if (!conversaciones[from]) {
    conversaciones[from] = [];
  }

  conversaciones[from].push({ role: 'user', content: texto });

  if (conversaciones[from].length > 10) {
    conversaciones[from] = conversaciones[from].slice(-10);
  }

  var mensajes = conversaciones[from];

  axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: mensajes
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
    console.log('Claude respondio: ' + respuesta);

    conversaciones[from].push({ role: 'assistant', content: respuesta });

    var imagenMatch = respuesta.match(/\[IMAGEN:(\w+)\]/);
    var textoLimpio = respuesta.replace(/\[IMAGEN:\w+\]/g, '').trim();

    enviarMensaje(from, textoLimpio).then(function() {
      if (imagenMatch) {
        var producto = imagenMatch[1];
        var imageId = IMAGENES[producto] ? IMAGENES[producto][0] : null;
        if (imageId) {
          setTimeout(function() {
            enviarImagen(from, imageId);
          }, 1000);
        }
      }
    });

  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    enviarMensaje(from, 'Hola! En este momento tengo un pequeño inconveniente tecnico. Escribeme en un momento y te respondo.');
  });
}

function enviarMensaje(to, texto) {
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: texto }
    },
    {
      headers: {
        'Authorization': 'Bearer ' + META_API_TOKEN,
        'Content-Type': 'application/json'
      }
    }
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
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'image',
      image: { link: imageUrl }
    },
    {
      headers: {
        'Authorization': 'Bearer ' + META_API_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  ).then(function() {
    console.log('Imagen enviada a ' + to);
  }).catch(function(error) {
    console.error('Error imagen:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

app.listen(PORT, function() {
  console.log('Agente Lili V5 con Claude AI en puerto ' + PORT);
});

module.exports = app;
