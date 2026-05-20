const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Configuración
const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hecho_por_lili_2026';

// Validar variables de entorno
if (!META_API_TOKEN || !PHONE_NUMBER_ID || !WABA_ID) {
  console.error('❌ Error: Faltan variables de entorno');
  console.error('Necesitas: META_API_TOKEN, PHONE_NUMBER_ID, WABA_ID');
  process.exit(1);
}

// ==================== WEBHOOK VERIFICATION ====================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Error en verificación de webhook');
    res.sendStatus(403);
  }
});

// ==================== WEBHOOK MESSAGE HANDLER ====================
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (value?.messages) {
      const message = value.messages[0];
      const sender = message.from;
      const messageText = message.text?.body || '';

      console.log(`📨 Mensaje recibido de ${sender}: ${messageText}`);

      // Procesar mensaje
      handleMessage(sender, messageText);
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

// ==================== MESSAGE HANDLER ====================
async function handleMessage(phoneNumber, userMessage) {
  try {
    // Respuesta simple mientras configuramos Claude
    const responses = {
      'hola': '¡Hola! Soy Lili 😊 Bienvenido a Hecho por Lili. ¿En qué puedo ayudarte?',
      'precio': 'Nuestros precios varían según cada pieza personalizada. ¿Cuál es el producto que te interesa? (escritorio, repisa, tocador, cama, etc.)',
      'escritorio': 'Nuestro Escritorio Flotante es una pieza artesanal en roble macizo. ¿Puedes enviarme una foto de tu espacio y las medidas? Así veo exactamente qué necesitas 📐',
      'repisa': 'La Repisa Flotante en roble natural es perfecta para organizar tu espacio. ¿Cuántos cm de ancho necesitas? (60, 80 o 100cm)',
    };

    let aiResponse = responses['hola'];
    const lowerMessage = userMessage.toLowerCase();

    for (const [key, value] of Object.entries(responses)) {
      if (lowerMessage.includes(key)) {
        aiResponse = value;
        break;
      }
    }

    // Enviar respuesta a WhatsApp
    await sendWhatsAppMessage(phoneNumber, aiResponse);
    console.log(`✅ Respuesta enviada a ${phoneNumber}`);

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message);
    await sendWhatsAppMessage(phoneNumber, 'Hola! Hubo un error. Intenta de nuevo en un momento 😊');
  }
}

// ==================== SEND WHATSAPP MESSAGE ====================
async function sendWhatsAppMessage(phoneNumber, messageText) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phoneNumber,
      type: 'text',
      text: {
        body: messageText
      }
    }, {
      headers: {
        'Authorization': `Bearer ${META_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ WhatsApp message sent: ${response.data.messages[0].id}`);
    return response.data;

  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     🪵 HECHO POR LILI - AGENTE ACTIVO 🪵    ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook URL: https://hospitable-appreciation-production-8e5b.up.railway.app/webhook`);
  console.log(`✅ Token verificación: ${WEBHOOK_VERIFY_TOKEN}\n`);
});

module.exports = app;
