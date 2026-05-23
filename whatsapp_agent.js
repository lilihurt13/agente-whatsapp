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

      // Procesar mensaje con Claude
      handleMessage(sender, messageText);
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

// ==================== MESSAGE HANDLER CON CLAUDE ====================
async function handleMessage(phoneNumber, userMessage) {
  try {
    // Llamar a Claude API
    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `Eres Lili, fundadora de Hecho por Lili, una marca de muebles artesanales en roble macizo. 
Tu rol es responder consultas de clientes sobre productos, precios y detalles de fabricación.

IMPORTANTE:
- Nunca des precio de frente. Primero pide foto/medidas del espacio
- Si preguntan precio sin contexto: "Hola! Claro, cada pieza es personalizada. ¿Puedes enviar una foto de tu espacio y medidas? Así veo exactamente qué necesitas"
- Los productos principales: Escritorio Flotante ($1.590.000), Repisa Flotante ($220.000), Tocador, Cama, Recibidor
- Tiempo de fabricación: 10-15 días
- Entrega e instalación incluida en Medellín
- Material: Roble macizo natural, acabado protector
- Tono: Cálido, cercano, sin presión. Usa emojis moderados (😊✨👌🪵)
- Si es proyecto futuro: da info, no presiones
- Si piden algo custom: describe cómo funciona el proceso personalizado`,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || ''
      }
    });

    const aiResponse = claudeResponse.data.content[0].text;

    // Enviar respuesta a WhatsApp
    await sendWhatsAppMessage(phoneNumber, aiResponse);
    console.log(`✅ Respuesta enviada a ${phoneNumber}`);

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message);
    // Enviar respuesta de error al usuario
    await sendWhatsAppMessage(phoneNumber, 'Hola! Hubo un error procesando tu mensaje. Intenta de nuevo en un momento 😊');
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
