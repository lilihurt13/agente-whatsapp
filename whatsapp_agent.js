const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hecho_por_lili_2026';

console.log('🎯 Iniciando agente Lili...');
console.log('✅ WEBHOOK_VERIFY_TOKEN:', WEBHOOK_VERIFY_TOKEN);
console.log('✅ PHONE_NUMBER_ID:', PHONE_NUMBER_ID);

// ==================== HEALTH CHECK ====================
app.get('/', (req, res) => {
  console.log('✅ GET / - Health check');
  res.json({ 
    status: '✅ Agente Lili funcionando',
    timestamp: new Date().toISOString()
  });
});

// ==================== WEBHOOK VERIFICATION ====================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook verification request:');
  console.log('  Mode:', mode);
  console.log('  Token received:', token);
  console.log('  Token expected:', WEBHOOK_VERIFY_TOKEN);
  console.log('  Challenge:', challenge);

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFIED SUCCESSFULLY!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification FAILED');
    console.log('  Mode match:', mode === 'subscribe');
    console.log('  Token match:', token === WEBHOOK_VERIFY_TOKEN);
    res.sendStatus(403);
  }
});

// ==================== WEBHOOK MESSAGES ====================
app.post('/webhook', (req, res) => {
  console.log('📨 Webhook POST received');
  
  // Responder inmediatamente a Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    
    // Extraer mensaje
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    
    if (message) {
      const from = message.from;
      const text = message.text?.body || '';
      
      console.log(`💬 Mensaje de ${from}: ${text}`);
      
      // Enviar respuesta automática simple
      setTimeout(() => {
        sendMessage(from, '¡Hola! 👋 Soy Lili. Gracias por escribir. En breve me pongo en contacto. 🪵');
      }, 500);
    }
  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
});

// ==================== SEND MESSAGE ====================
async function sendMessage(to, text) {
  try {
    console.log(`📤 Enviando mensaje a ${to}: ${text}`);
    
    const response = await axios.post(
      `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${META_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Mensaje enviado exitosamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`\n🚀 Agente Lili ejecutándose en puerto ${PORT}`);
  console.log(`📍 Webhook URL: https://hospitable-appreciation-production-8e5b.up.railway.app/webhook`);
  console.log(`🔑 Verify Token: ${WEBHOOK_VERIFY_TOKEN}\n`);
});

module.exports = app;
