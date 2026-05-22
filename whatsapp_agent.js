const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ==================== MEMORIA DE CONVERSACIONES ====================
const conversaciones = {};

// ==================== IMÁGENES POR PRODUCTO ====================
const IMAGENES = {
  escritorio_flotante: ['1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4', '1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA', '1LF0PnTwpxq5-HNczQxqC-TOBoNv-dUvz'],
  repisas: ['1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0', '1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm', '1kSbfuZdg01iNUeLptk-kWs71TiFhPSjK'],
  recibidor: ['1zgdgfRKFZimZWlz1FRJj32koY7d00u4I', '1u1EuYOvZWjqWrBr8brgzFkuYG9i3xDUL'],
  mesa_auxiliar: ['1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR', '1CCsMSR_0b_mnWxKazmPL0KRkkRxq3lau'],
  mesa_centro: ['1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC', '1A1CwRR0ASxi06EE6BtaJgFDjC5Uf7goY'],
  cama: ['1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll', '1AsIa2KvI82mvOyOnKzJMngrXFJyx4VQV']
};

// ==================== SYSTEM PROMPT DE LILI ====================
const SYSTEM_PROMPT = `Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, una marca de muebles artesanales en roble natural en Medellín, Colombia.

PERSONALIDAD Y TONO:
- Cálida, cercana, entusiasta pero profesional
- Usas emojis naturalmente (🙌 😊 👋 🪵 ✨ 🔥 👍)
- Llamas a los clientes por su nombre cuando lo sabes
- Eres consultora, no solo vendedora
- Frases típicas tuyas: "¡Hola!", "Estoy acá para guiarte", "Perfecta pregunta", "¡Buena noticia!"

PRODUCTOS Y PRECIOS:
1. Escritorio Flotante: 75x46.5x15 cm | $1.590.000 | 12-15 días | Cajón con cierre lento, esquinas redondeadas, instalación incluida Medellín
2. Repisas Flotantes: 60cm $220k / 80cm $260k / 100cm $320k / 120cm $380k | 5-6 días | 15cm profundidad, soportes invisibles
3. Recibidor/Banco: 96x30x40 cm | $2.100.000 | 15 días | Cajón + cojín incluido
4. Mesa Auxiliar: 35x45x50 cm | $420.000 | 8 días | Patas desmontables
5. Mesa de Centro con Jardinera: 140x120 cm | $4.200.000 | 20-25 días
6. Cama Queen listonada: $8.700.000 | Cama Queen lisa: $8.200.000 | 4-6 semanas

REGLAS DE CONVERSACIÓN:
- Siempre: 1) Responde claro 2) Agrega valor 3) Haz una pregunta gancho
- Para productos +$2M: mínimo 2-3 intercambios ANTES de dar precio
- NUNCA justifiques el precio, comunica valor
- Si piden imagen, responde con texto Y incluye al final exactamente: [IMAGEN:nombre_producto] 
  donde nombre_producto es uno de: escritorio_flotante, repisas, recibidor, mesa_auxiliar, mesa_centro, cama
- Si el cliente menciona espacio (habitación, sala, oficina), adapta tu recomendación
- Instalación en Medellín incluida para escritorio. Para repisas es opcional ($30k-$50k adicional)
- Envíos a todo Colombia disponibles

PREGUNTAS GANCHO QUE SIEMPRE USAS:
- "¿Para qué espacio la estás buscando?"
- "¿Cuántos cm mide el ancho del espacio?"
- "¿Ya tienes el lugar definido o estás mirando opciones?"
- "¿La necesitas con envío o estás en Medellín?"

MATERIAL SIEMPRE DESTACAR:
- Roble alistonado MACIZO (no MDF, no aglomerado)
- Cada pieza es única por la veta natural
- Hecho a mano, no producción masiva
- Envejece bien, dura años

Responde SOLO en español. Sé concisa (máximo 5-6 líneas por respuesta). Natural y conversacional como WhatsApp.`;

// ==================== HEALTH CHECK ====================
app.get('/', (req, res) => {
  res.json({ status: '✅ Agente Lili V5 con Claude AI - Activo' });
});

// ==================== WEBHOOK VERIFICATION ====================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==================== WEBHOOK MESSAGES ====================
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from;
      const texto = message.text.body;
      console.log(`📨 De ${from}: ${texto}`);
      setTimeout(() => procesarMensaje(from, texto), 500);
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

// ==================== PROCESAMIENTO CON CLAUDE AI ====================
async function procesarMensaje(from, texto) {
  try {
    // Inicializar conversación si no existe
    if (!conversaciones[from]) {
      conversaciones[from] = [];
    }

    // Agregar mensaje del usuario al historial
    conversaciones[from].push({ role: 'user', content: texto });

    // Mantener solo los últimos 10 mensajes (5 intercambios)
    if (conversaciones[from].length > 10) {
      conversaciones[from] = conversaciones[from].slice(-10);
    }

    // Llamar a Claude AI
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
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
    );

    const respuestaCompleta = response.data.content[0].text;
    console.log(`🤖 Claude respondió: ${respuestaCompleta}`);

    // Agregar respuesta al historial
    conversaciones[from].push({ role: 'assistant', content: respuestaCompleta });

    // Detectar si hay imagen solicitada
    const imagenMatch = respuestaCompleta.match(/\[IMAGEN:(\w+)\]/);
    const textoLimpio = respuestaCompleta.replace(/\[IMAGEN:\w+\]/g, '').trim();

    // Enviar respuesta de texto
    await enviarMensaje(from, textoLimpio);

    // Enviar imagen si aplica
    if (imagenMatch) {
      const producto = imagenMatch[1];
      const imageId = IMAGENES[producto]?.[0];
      if (imageId) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await enviarImagen(from, imageId);
      }
    }

  } catch (error) {
    console.error('❌ Error procesando:', error.response?.data || error.message);
    await enviarMensaje(from, '¡Hola! 🙌 En este momento tengo un pequeño inconveniente técnico. Escríbeme en un momento y te respondo. 😊');
  }
}

// ==================== ENVIAR MENSAJE ====================
async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } },
      { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('✅ Mensaje enviado');
  } catch (error) {
    console.error('❌ Error mensaje:', error.response?.data || error.message);
  }
}

// ==================== ENVIAR IMAGEN ====================
async function enviarImagen(to, imageId) {
  try {
    const imageUrl = `https://drive.google.com/uc?export=view&id=${imageId}`;
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl } },
      { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('✅ Imagen enviada');
  } catch (error) {
    console.error('❌ Error imagen:', error.response?.data || error.message);
  }
}

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`\n🚀 Agente Lili V5 con Claude AI en puerto ${PORT}\n`);
});

module.exports = app;
