const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';

// ── Global error handlers ────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] ❌ Unhandled Promise Rejection:`, reason);
});

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ Uncaught Exception:`, err);
  // Give the logger a tick to flush, then exit so Railway can restart the process
  process.exit(1);
});

process.on('exit', (code) => {
  console.log(`[${new Date().toISOString()}] 🛑 Process exiting with code: ${code}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] 📴 SIGTERM received — shutting down gracefully`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] 📴 SIGINT received — shutting down gracefully`);
  process.exit(0);
});

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
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const from = message.from;
      const text = message.text?.body || '';

      console.log(`[${new Date().toISOString()}] 📨 De ${from}: ${text}`);

      // Respuesta automática
      setTimeout(() => {
        sendMessage(from, '¡Hola! 👋 Soy Lili. Gracias por escribir. En breve me pongo en contacto. 🪵');
      }, 500);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error en POST /webhook:`, error);
    res.sendStatus(500);
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

try {
  const server = app.listen(PORT, '0.0.0.0', () => {
    const addr = server.address();
    console.log(`[${new Date().toISOString()}] 🚀 Agente en puerto ${PORT} — escuchando en ${addr.address}:${addr.port}`);
    console.log(`[${new Date().toISOString()}] ✅ Servidor activo y esperando conexiones`);
  });

  server.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ❌ Error al iniciar el servidor:`, err);
    process.exit(1);
  });
} catch (err) {
  console.error(`[${new Date().toISOString()}] ❌ Excepción al llamar app.listen():`, err);
  process.exit(1);
}

module.exports = app;
