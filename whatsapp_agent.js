const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';

// Health check
app.get('/', (req, res) => {
  res.json({ status: '✅ Agente Lili activo' });
});

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook messages (POST)
app.post('/webhook', (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const from = message.from;
      const text = message.text?.body || '';

      console.log(`📨 De ${from}: ${text}`);

      // Respuesta automática
      setTimeout(() => {
        sendMessage(from, '¡Hola! 👋 Soy Lili. Gracias por escribir. En breve me pongo en contacto. 🪵');
      }, 500);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
});

// Send message
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: { 'Authorization': `Bearer ${META_API_TOKEN}` }
      }
    );
    console.log('✅ Mensaje enviado');
  } catch (error) {
    console.error('Error enviando:', error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Agente en puerto ${PORT}`);
});

module.exports = app;
