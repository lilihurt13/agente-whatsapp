const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hecho_por_lili_2026';

app.get('/', (req, res) => {
  res.json({ status: '✅ Agente activo', time: new Date() });
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (msg) {
    console.log(`Mensaje: ${msg.from} - ${msg.text?.body}`);
    sendMsg(msg.from, 'Hola desde Hecho por Lili! 😊');
  }
});

async function sendMsg(to, text) {
  try {
    await axios.post(`https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to, type: 'text',
      text: { body: text }
    }, {
      headers: { 'Authorization': `Bearer ${META_API_TOKEN}` }
    });
  } catch (e) {
    console.error(e.message);
  }
}

app.listen(PORT, () => console.log(`✅ Port ${PORT}`));
