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

// ==================== ESTADO DEL AGENTE ====================
const conversaciones = {};
const pausados = {};      // numeros pausados individualmente
let pausadoTodo = false;  // pausa global

// ==================== IMAGENES ====================
const IMAGENES = {
  escritorio_flotante: ['1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4', '1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA'],
  escritorio_cajones: ['1NB7YBRnAG9I1xoUuruQR70YJ16KQmfiT', '1NV1bqete6xMKybgF7sOVOEqt80JKzmQ2'],
  repisas: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm'],
  recibidor: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I', '1u1EuYOvZWjqWrBr8brgzFkuYG9i3xDUL'],
  mesa_auxiliar: ['1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR', '1CCsMSR_0b_mnWxKazmPL0KRkkRxq3lau'],
  mesa_centro: ['1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC', '1A1CwRR0ASxi06EE6BtaJgFDjC5Uf7goY'],
  cama: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll', '1AsIa2KvI82mvOyOnKzJMngrXFJyx4VQV']
};

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = "Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles artesanales en roble natural en Medellin, Colombia.\n\nPERSONALIDAD Y TONO:\n- Calida, cercana, entusiasta pero profesional\n- Usas emojis naturalmente (🙌 😊 👋 🪵 ✨ 🔥 👍)\n- Llamas clientes por nombre cuando lo sabes\n- Eres consultora de espacios, no solo vendedora\n- Respuestas cortas, max 5-6 lineas, natural como WhatsApp\n- NUNCA menciones estilos como rustico, moderno, escandinavo\n- Tu linea es siempre: roble natural, lineas limpias, bordes suaves, hecho a mano\n\nSALUDO INICIAL (primer mensaje de cada persona):\n¡Hola! 👋\nQué gusto conocerte 🌿 Soy Lili, diseñadora y fundadora de Hecho por Lili. Hacemos muebles en roble natural para espacios que realmente funcionen y se vean increíbles.\n¿En qué te puedo ayudar? ¿Buscas algo específico para tu casa? 😊\n\nCATALOGO DE PRODUCTOS:\n\n1. ESCRITORIO FLOTANTE (producto estrella)\n- Medidas: 75 x 46.5 x 15 cm\n- Material: Roble alistonado macizo 18mm\n- Incluye: Cajon frontal con cierre lento, esquinas redondeadas, instalacion incluida Medellin\n- Precio: $1.590.000 COP\n- Tiempo: 12-15 dias habiles\n- Opcionales: repisa superior flotante, ajuste de ancho\n\n2. ESCRITORIO CON CAJONES LATERALES\n- Medidas: 120 x 60 x 77 cm (con patas, no flotante)\n- Material: Roble alistonado\n- Incluye: 2 cajones laterales, entrepaños, estructura solida\n- Precio: $3.200.000 COP\n- Tiempo: 20 dias habiles\n\n3. REPISAS FLOTANTES\n- Medidas: 60/80/100/120 cm ancho, 15cm profundidad, 3cm espesor\n- Precios: 60cm=$220k / 80cm=$260k / 100cm=$320k / 120cm=$380k\n- Instalacion opcional: $30k-$50k en Medellin\n- Tiempo: 5-6 dias habiles\n\n4. RECIBIDOR / BANCO\n- Medidas: 96 x 30 x 40 cm (incluye cojin)\n- Incluye: cajon frontal, cierre lento, cojin\n- Precio: $2.100.000 COP\n- Tiempo: 15 dias habiles\n\n5. MESA AUXILIAR\n- Medidas: 35 x 45 x 50 cm, patas desmontables\n- Precio: $420.000 COP\n- Tiempo: 8 dias habiles\n\n6. MESA DE CENTRO CON JARDINERA\n- Medidas: 140 x 120 cm\n- Precio: $4.200.000 COP\n- Tiempo: 20-25 dias habiles\n\n7. CAMA QUEEN\n- Respaldo listonado: $8.700.000 COP\n- Respaldo liso: $8.200.000 COP\n- Tiempo: 4-6 semanas\n\nDISENOS PERSONALIZADOS:\n- Si ninguno del catalogo encaja, se pueden hacer disenos personalizados\n- El cliente puede enviar fotos de referencia\n- NUNCA des precio de medidas personalizadas automaticamente, siempre di que debes revisar medidas y hacer despiece primero\n- Frase: Me cuentas las medidas que necesitas y yo te preparo la cotizacion 😊\n\nREGLAS DE CONVERSION MUY IMPORTANTES:\n1. NUNCA des precio como primera respuesta cuando preguntan por un producto\n2. Primero: describe el producto con valor (material, caracteristicas, diferencial)\n3. Segundo: pregunta para que espacio, que medidas tiene disponibles\n4. Tercero: despues de 1-2 intercambios, ahi si das el precio con todo el contexto\n5. Productos mas de $2M: minimo 2-3 intercambios antes de precio\n6. NUNCA inventes precios de medidas no estandar\n7. NUNCA digas que solo tienes un tipo de escritorio, tienes dos opciones y disenos personalizados\n8. Material siempre: roble alistonado MACIZO (no MDF, no aglomerado)\n9. Diferencial: pieza hecha a mano, no produccion masiva, vetas unicas\n10. Anticipo 60% para iniciar produccion\n11. Envios a todo Colombia\n\nCUANDO ENVIAR IMAGENES:\n- Si el cliente pide foto o imagen: responde el texto Y escribe exactamente [IMAGEN:producto] al final\n- Si describes un producto por primera vez puedes incluir imagen\n- productos validos: escritorio_flotante, escritorio_cajones, repisas, recibidor, mesa_auxiliar, mesa_centro, cama\n\nCUANDO ESCALAR A LILI (di exactamente esto):\n- Si piden diseno personalizado con referencias: Perfecto! Para disenos con referencias necesito coordinarlo directamente contigo. En un momento Lili te escribe para revisar los detalles 😊\n- Si piden cotizacion de medidas especiales: Claro! Para darte un precio exacto necesito revisar las medidas y hacer el despiece. En un momento Lili te escribe con la cotizacion 😊\n- Si piden renders o propuesta de diseno: Con gusto! Lili te prepara una propuesta personalizada. En un momento te contacta 😊\n\nPREGUNTAS GANCHO (rotar):\n- Para que espacio lo estas buscando?\n- Cuanto mide el ancho del espacio donde lo quieres?\n- Ya tienes el lugar definido o estas explorando opciones?\n- Lo necesitas con envio o estas en Medellin?\n- Tienes alguna imagen de referencia de lo que buscas?";

// ==================== PANEL DE CONTROL ====================
app.get('/control', function(req, res) {
  var token = req.query.token;
  var cmd = req.query.cmd;
  var numero = req.query.numero;

  if (token !== CONTROL_TOKEN) {
    return res.status(403).send('No autorizado');
  }

  if (cmd === 'pausatodo') {
    pausadoTodo = true;
    return res.send('PAUSADO TODO ✅ El agente no responde a nadie.');
  }

  if (cmd === 'todo') {
    pausadoTodo = false;
    Object.keys(pausados).forEach(function(n) { delete pausados[n]; });
    return res.send('REACTIVADO TODO ✅ El agente responde a todos.');
  }

  if (cmd === 'pausa' && numero) {
    pausados[numero] = true;
    return res.send('PAUSADO ✅ El agente no responde a ' + numero + ' hasta que lo reactives.');
  }

  if (cmd === 'reanudar' && numero) {
    delete pausados[numero];
    return res.send('REACTIVADO ✅ El agente vuelve a responder a ' + numero);
  }

  if (cmd === 'estado') {
    var estado = {
      pausadoTodo: pausadoTodo,
      numerosPausados: Object.keys(pausados)
    };
    return res.json(estado);
  }

  return res.send('Comando no reconocido. Usa: pausatodo, todo, pausa&numero=XXX, reanudar&numero=XXX, estado');
});

// ==================== HEALTH CHECK ====================
app.get('/', function(req, res) {
  res.json({
    status: 'Agente Lili V7 activo',
    pausadoTodo: pausadoTodo,
    numerosPausados: Object.keys(pausados).length
  });
});

// ==================== WEBHOOK VERIFICATION ====================
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

// ==================== WEBHOOK MESSAGES ====================
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

      // Verificar si esta pausado
      if (pausadoTodo) {
        console.log('Agente pausado globalmente, ignorando mensaje de ' + from);
        return;
      }
      if (pausados[from]) {
        console.log('Numero ' + from + ' pausado, ignorando mensaje');
        return;
      }

      setTimeout(function() {
        procesarMensaje(from, texto);
      }, 500);
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

// ==================== CLAUDE AI ====================
function procesarMensaje(from, texto) {
  if (!conversaciones[from]) {
    conversaciones[from] = [];
  }

  conversaciones[from].push({ role: 'user', content: texto });

  if (conversaciones[from].length > 10) {
    conversaciones[from] = conversaciones[from].slice(-10);
  }

  axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5',
      max_tokens: 500,
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

    var imagenMatch = respuesta.match(/\[IMAGEN:(\w+)\]/);
    var textoLimpio = respuesta.replace(/\[IMAGEN:\w+\]/g, '').trim();

    enviarMensaje(from, textoLimpio).then(function() {
      if (imagenMatch) {
        var producto = imagenMatch[1];
        var imageId = IMAGENES[producto] ? IMAGENES[producto][0] : null;
        if (imageId) {
          setTimeout(function() {
            enviarImagen(from, imageId);
          }, 1500);
        }
      }
    });

  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    enviarMensaje(from, 'Hola! 🙌 Estoy revisando tu mensaje, en un momento te respondo 😊');
  });
}

// ==================== ENVIAR MENSAJE ====================
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

// ==================== ENVIAR IMAGEN ====================
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

// ==================== START ====================
app.listen(PORT, function() {
  console.log('Agente Lili V7 en puerto ' + PORT);
});

module.exports = app;
