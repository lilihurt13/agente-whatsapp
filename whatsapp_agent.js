const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';

const PRODUCTOS = {
  escritorio_flotante: {
    nombre: 'Escritorio Flotante',
    medidas: '75 x 46.5 x 15 cm',
    material: 'Roble alistonado',
    precio: '$1.590.000',
    tiempo: '12-15 días',
    imagenes: ['1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4', '1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA']
  },
  repisas: {
    nombre: 'Repisas Flotantes',
    medidas: '60/80/100/120 cm',
    precio: 'Desde $220.000',
    tiempo: '5-6 días',
    imagenes: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm']
  },
  recibidor: {
    nombre: 'Recibidor/Banco',
    medidas: '96 x 30 x 40 cm',
    precio: '$2.100.000',
    tiempo: '15 días',
    imagenes: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I']
  },
  cama_queen: {
    nombre: 'Cama Queen',
    precio: '$8.200.000 - $8.700.000',
    tiempo: '4-6 semanas',
    imagenes: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll']
  }
};

app.get('/', (req, res) => {
  res.json({ status: '✅ Agente Lili V4 Activo' });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const from = message.from;
      const texto = message.text?.body || '';
      console.log(`📨 De ${from}: ${texto}`);
      setTimeout(() => procesarMensaje(from, texto), 500);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
});

async function procesarMensaje(from, texto) {
  const t = texto.toLowerCase();
  let respuesta = '';
  let imagenId = null;

  if (t.includes('hola') || t.includes('hi') || t.includes('buenos') || t.includes('buenas')) {
    respuesta = `¡Hola! 👋 Soy Lili Hurtado.\nSoy Diseñadora de Producto y diseño cada pieza pensando en el espacio y la persona que la va a usar.\n\nDiseño y fabrico piezas en roble natural.\n\n¿Cuéntame cómo puedo ayudarte?`;
  }
  else if (t.includes('imagen') || t.includes('foto') || t.includes('ver') || t.includes('muestra')) {
    const producto = detectarProducto(texto);
    const info = PRODUCTOS[producto];
    respuesta = `¡Claro que sí! 😊 Te muestro cómo queda el ${info.nombre}.\n\nEs en roble natural, cada pieza es única por la veta de la madera. 🪵\n\n¿Lo estás pensando para qué espacio?`;
    imagenId = info.imagenes?.[0];
  }
  else if (t.includes('precio') || t.includes('valor') || t.includes('cuánto') || t.includes('cuanto') || t.includes('vale')) {
    const producto = detectarProducto(texto);
    const info = PRODUCTOS[producto];
    respuesta = `¡Hola! 🙌\n\nEl ${info.nombre} en roble alistonado tiene un valor de ${info.precio}\n\nIncluye:\n✅ Roble macizo alistonado (no aglomerado)\n✅ Esquinas redondeadas, bordes suaves\n✅ Acabado natural\n✅ Instalación incluida en Medellín\n⏱️ Tiempo de entrega: ${info.tiempo}\n\n¿Lo estás pensando para qué espacio? 👍`;
    imagenId = info.imagenes?.[0];
  }
  else if (t.includes('medida') || t.includes('tamaño') || t.includes('dimensión') || t.includes('cm')) {
    respuesta = `¡Buena pregunta! 😊\n\n¿Cuántos cm mide el ancho del espacio donde lo quieres instalar?\n(de esquina a esquina)\n\nAsí hago la pieza exacta para que encaje perfecta 👍\n\nO si quieres una medida específica, cuéntame cuál sería.`;
  }
  else if (t.includes('personaliz') || t.includes('ajustar') || t.includes('medida específica')) {
    respuesta = `¡Perfecto! 😊\n\nTodos nuestros muebles se fabrican bajo pedido.\n\nPuedo ajustar cualquier medida según tu espacio.\n\n¿Cuáles serían tus medidas ideales? 🪵`;
  }
  else if (t.includes('tiempo') || t.includes('entrega') || t.includes('cuándo') || t.includes('demora')) {
    const producto = detectarProducto(texto);
    const info = PRODUCTOS[producto];
    respuesta = `¡Hola! 🙌\n\nEl tiempo de entrega del ${info.nombre} es de ${info.tiempo} hábiles.\n\nTodos los muebles se fabrican bajo pedido con un anticipo del 60% para arrancar. 🔥\n\n¿Te funciona ese tiempo?`;
  }
  else if (t.includes('material') || t.includes('madera') || t.includes('roble')) {
    respuesta = `¡Sí! 🙌 Todos los muebles están hechos en Roble Alistonado.\n\nEs madera maciza real, no aglomerado ni MDF.\n\nCada pieza es única por la veta natural de la madera. 🪵\n\n¿Te interesa algún mueble en especial?`;
  }
  else if (t.includes('instalación') || t.includes('instalar') || t.includes('montaje')) {
    respuesta = `¡Sí! 😊 La instalación está incluida en Medellín.\n\nNosotros vamos, perforamos y dejamos todo instalado y nivelado. 🔧\n\n¿En qué zona de Medellín estás?`;
  }
  else {
    respuesta = `¡Hola! 🙌 Estoy acá para ayudarte.\n\nDiseño y fabrico piezas en roble natural bajo pedido.\n\n¿Qué mueble tienes en mente? 🪵`;
  }

  await enviarMensaje(from, respuesta);
  if (imagenId) await enviarImagen(from, imagenId);
}

function detectarProducto(texto) {
  const t = texto.toLowerCase();
  if (t.includes('repisa') || t.includes('estante')) return 'repisas';
  if (t.includes('recibidor') || t.includes('banco')) return 'recibidor';
  if (t.includes('cama')) return 'cama_queen';
  return 'escritorio_flotante';
}

async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } },
      { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
    );
    console.log('✅ Mensaje enviado');
  } catch (error) {
    console.error('❌ Error mensaje:', error.response?.data || error.message);
  }
}

async function enviarImagen(to, imageId) {
  try {
    const imageUrl = `https://drive.google.com/uc?export=view&id=${imageId}`;
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl } },
      { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
    );
    console.log('✅ Imagen enviada');
  } catch (error) {
    console.error('❌ Error imagen:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Agente Lili V4 en puerto ${PORT}`);
});

module.exports = app;
