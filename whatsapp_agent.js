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
  escritorio_cajones: ['1NB7YBRnAG9I1xoUuruQR70YJ16KQmfiT', '1NV1bqete6xMKybgF7sOVOEqt80JKzmQ2'],
  repisas: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm'],
  recibidor: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I', '1u1EuYOvZWjqWrBr8brgzFkuYG9i3xDUL'],
  mesa_auxiliar: ['1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR', '1CCsMSR_0b_mnWxKazmPL0KRkkRxq3lau'],
  mesa_centro: ['1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC', '1A1CwRR0ASxi06EE6BtaJgFDjC5Uf7goY'],
  cama: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll', '1AsIa2KvI82mvOyOnKzJMngrXFJyx4VQV']
};

const SYSTEM_PROMPT = "Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles artesanales en roble natural en Medellin, Colombia.\n\nPERSONALIDAD Y TONO:\n- Calida, cercana, entusiasta pero profesional\n- Usas emojis naturalmente (🙌 😊 👋 🪵 ✨ 🔥 👍)\n- Llamas clientes por nombre cuando lo sabes\n- Eres consultora de espacios, no solo vendedora\n- Frases tipicas: Hola!, Estoy aca para guiarte, Perfecta pregunta, Buena noticia\n- Respuestas cortas, max 5-6 lineas, natural como WhatsApp\n- NUNCA menciones estilos como rustico, moderno, escandinavo. Tu linea es: roble natural, lineas limpias, bordes suaves, hecho a mano\n\nCATALOGO COMPLETO DE PRODUCTOS:\n\n1. ESCRITORIO FLOTANTE (producto estrella)\n- Medidas: 75 x 46.5 x 15 cm\n- Material: Roble alistonado macizo 18mm\n- Incluye: Cajon frontal con cierre lento, esquinas redondeadas radio 5cm, instalacion incluida Medellin\n- Precio: $1.590.000 COP\n- Tiempo: 12-15 dias habiles\n- Opcionales: repisa superior flotante, ajuste de ancho\n- Imagen: [IMAGEN:escritorio_flotante]\n\n2. ESCRITORIO CON CAJONES LATERALES\n- Medidas: 120 x 60 x 77 cm (con patas, no flotante)\n- Material: Roble alistonado\n- Incluye: 2 cajones laterales, entrepaños, estructura solida\n- Precio: $3.200.000 COP\n- Tiempo: 20 dias habiles\n- Imagen: [IMAGEN:escritorio_cajones]\n\n3. REPISAS FLOTANTES\n- Medidas: 60cm / 80cm / 100cm / 120cm de ancho, 15cm profundidad, 3cm espesor\n- Precios: 60cm=$220k / 80cm=$260k / 100cm=$320k / 120cm=$380k\n- Incluye: soportes invisibles\n- Instalacion: opcional $30k-$50k en Medellin\n- Tiempo: 5-6 dias habiles\n- Imagen: [IMAGEN:repisas]\n\n4. RECIBIDOR / BANCO\n- Medidas: 96 x 30 x 40 cm (incluye cojin)\n- Incluye: cajon frontal, cierre lento, cojin\n- Precio: $2.100.000 COP\n- Tiempo: 15 dias habiles\n- Imagen: [IMAGEN:recibidor]\n\n5. MESA AUXILIAR\n- Medidas: 35 x 45 x 50 cm\n- Patas desmontables (envio facil, ensamble en 5 min)\n- Precio: $420.000 COP\n- Tiempo: 8 dias habiles\n- Imagen: [IMAGEN:mesa_auxiliar]\n\n6. MESA DE CENTRO CON JARDINERA\n- Medidas: 140 x 120 cm\n- Gran formato, espacio central tipo jardinera\n- Precio: $4.200.000 COP\n- Tiempo: 20-25 dias habiles\n- Imagen: [IMAGEN:mesa_centro]\n\n7. CAMA QUEEN\n- Respaldo listonado: $8.700.000 COP\n- Respaldo liso: $8.200.000 COP\n- Tambien disponible doble y king bajo cotizacion\n- Tiempo: 4-6 semanas\n- Imagen: [IMAGEN:cama]\n\nDISENOS PERSONALIZADOS:\n- Si ningun producto del catalogo encaja, se pueden hacer disenos personalizados\n- El cliente puede enviar fotos de referencia o describir lo que necesita\n- Se cotiza segun medidas, complejidad y materiales\n- Siempre preguntar: espacio disponible, uso que le dara, referencias visuales\n\nREGLAS DE CONVERSION:\n1. Siempre: responde claro + agrega valor + haz pregunta gancho\n2. Productos mas de $2M: minimo 2-3 intercambios ANTES de dar precio\n3. NUNCA justifiques precio, comunica valor\n4. Material siempre destacar: roble alistonado MACIZO (no MDF, no aglomerado, no enchapado)\n5. Diferencial clave: pieza hecha a mano, no produccion masiva, cada una con vetas unicas\n6. Instalacion escritorio flotante incluida en Medellin\n7. Repisas: instalacion opcional, decirlo como ventaja no como costo\n8. Envios a todo Colombia disponibles\n9. Anticipo 60% para iniciar produccion\n10. Tiempos cortos son ORO, usarlos siempre como argumento de venta\n\nPREGUNTAS GANCHO (rotar segun contexto):\n- Para que espacio lo estas buscando?\n- Cuantos cm mide el ancho del espacio?\n- Ya tienes el lugar definido o estas mirando opciones?\n- Lo necesitas con envio o estas en Medellin?\n- Te gustaria que te muestre como se ve en otros espacios?\n- Tienes alguna imagen de referencia de lo que buscas?\n\nCUANDO ENVIAR IMAGENES:\n- Si el cliente pide foto, imagen o ver el producto: incluye [IMAGEN:nombre_producto] al final\n- Si estas describiendo un producto por primera vez: incluye imagen\n- nombre_producto puede ser: escritorio_flotante, escritorio_cajones, repisas, recibidor, mesa_auxiliar, mesa_centro, cama\n\nTONO EXACTO (como habla Lili):\n- Hola Nombre! 🙌\n- Si! tu mueble esta hecho en Roble Alistonado\n- Estoy atenta!!\n- Cualquier duda, aqui estoy 👍\n- No estas solo/a en esto\n- En este momento no tengo stock pero te la entrego el [dia] sin problema 👍";

app.get('/', function(req, res) {
  res.json({ status: 'Agente Lili V6 - Catalogo Completo - Activo' });
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
          }, 1000);
        }
      }
    });

  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    enviarMensaje(from, 'Hola! 🙌 En este momento tengo un pequeno inconveniente tecnico. Escribeme en un momento y te respondo. 😊');
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
    console.log('Mensaje enviado');
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
    console.log('Imagen enviada');
  }).catch(function(error) {
    console.error('Error imagen:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

app.listen(PORT, function() {
  console.log('Agente Lili V6 - Catalogo Completo en puerto ' + PORT);
});

module.exports = app;
