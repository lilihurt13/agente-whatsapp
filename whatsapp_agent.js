const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hecho_por_lili_2026';

const conversationHistory = {};

// ==================== IMAGEN URLs (CONVERTIDAS A DIRECTAS) ====================
const IMAGES = {
  escritorio: [
    'https://drive.google.com/uc?export=view&id=16YS9F18b45TkHYjfh6WbC_uaQEQoSVkG',
    'https://drive.google.com/uc?export=view&id=1wN3MFm3EEl5fLKQ_-sZA_atySSMqN2g4',
    'https://drive.google.com/uc?export=view&id=1LF0PnTwpxq5-HNczQxqC-TOBoNv-dUvz',
    'https://drive.google.com/uc?export=view&id=1Ms6lzMzB9HBrk8kDDb0Yx9NZKLSQiufA',
    'https://drive.google.com/uc?export=view&id=1DrUhGJhorXPDYJrDCTYjf55EPcRAVryv',
    'https://drive.google.com/uc?export=view&id=1HRRt5tRhJYsKqBskSk-Ga_HKZKsYohfP',
    'https://drive.google.com/uc?export=view&id=1sY5Nl-XHDvSTXw29sUYGzUQhy_ECIO6Z',
    'https://drive.google.com/uc?export=view&id=1wV5K5DNVAsIDD1F4V1foVcVovSQ9v5r5',
    'https://drive.google.com/uc?export=view&id=1SEOCQLGmDeALgZ0BgIfci32IA7fhrSIm',
  ],
  repisas: [
    'https://drive.google.com/uc?export=view&id=1smMRd6CCQB3R8bS4U3DLxbtvdd5anVo0',
    'https://drive.google.com/uc?export=view&id=1dVd5ox7wk0XLJTYV2ZscoZkqjAQe_5Rm',
    'https://drive.google.com/uc?export=view&id=1kSbfuZdg01iNUeLptk-kWs71TiFhPSjK',
    'https://drive.google.com/uc?export=view&id=1hB6z4zhhzXXOYvOK9FipgtwsvVyUG4oL',
    'https://drive.google.com/uc?export=view&id=1dM2Cb_WmmKr8cM2sFm0d5cYsbh8kTLQs',
    'https://drive.google.com/uc?export=view&id=1lLcWgcMGehEkBCR1p63dUbfjbG3VjerW',
    'https://drive.google.com/uc?export=view&id=1OdgtK2B4V3eSfXbMrLNMkmr4F2rN6BRd',
  ],
  mesaAuxiliar: [
    'https://drive.google.com/uc?export=view&id=1aBRkEeDdmtQmPWeJhPmIRSMUSMnpHzeR',
    'https://drive.google.com/uc?export=view&id=1CCsMSR_0b_mnWxKazmPL0KRkkRxq3lau',
    'https://drive.google.com/uc?export=view&id=1JqDqH1AQOaGl638Hrfq-0S-vDTDpsKva',
    'https://drive.google.com/uc?export=view&id=1bLwa9ObKT9zFHOuAPQ_KcIlNPZNIaPdy',
  ],
  escritorioNormal: [
    'https://drive.google.com/uc?export=view&id=1NB7YBRnAG9I1xoUuruQR70YJ16KQmfiT',
    'https://drive.google.com/uc?export=view&id=1NV1bqete6xMKybgF7sOVOEqt80JKzmQ2',
  ],
  mesaCentro: [
    'https://drive.google.com/uc?export=view&id=1bIA5m5cKtsyKDfPa5s5sb8NI5Yhj2bsC',
    'https://drive.google.com/uc?export=view&id=1A1CwRR0ASxi06EE6BtaJgFDjC5Uf7goY',
    'https://drive.google.com/uc?export=view&id=13AFfv3aZJFZ3KprQjjMlLjp3UpNBma37',
  ],
  recibidor: [
    'https://drive.google.com/uc?export=view&id=1zgdgfRKFZimZWlz1FRJj32koY7d00u4I',
    'https://drive.google.com/uc?export=view&id=1u1EuYOvZWjqWrBr8brgzFkuYG9i3xDUL',
    'https://drive.google.com/uc?export=view&id=1oJK-m1Q1Nqq_EeBWFS1itmEzKEcQC6mp',
    'https://drive.google.com/uc?export=view&id=1GqVk9RxRxW4OU3a0BfrILsyznIFC57cT',
  ],
  cama: [
    'https://drive.google.com/uc?export=view&id=1ga4uOOu5TpIZxldgZKKg9V8dvKR2DXll',
    'https://drive.google.com/uc?export=view&id=1AsIa2KvI82mvOyOnKzJMngrXFJyx4VQV',
    'https://drive.google.com/uc?export=view&id=1OI_LTFL_xO5SlwjLIUKaGA1f4P99mx_3',
    'https://drive.google.com/uc?export=view&id=1zm1OtKAdzB_p0sGL_v0CggCJ2M3L7Znk',
    'https://drive.google.com/uc?export=view&id=1Nk6-ahzIS0aWnxhaY0enLMslP8pTjdRV',
    'https://drive.google.com/uc?export=view&id=1p1z8zkvEMlkXtCh-Hr9hoEFKZ4xf5gDI',
  ]
};

// ==================== ENDPOINTS ====================
app.get('/', (req, res) => {
  res.json({ status: '✅ Agente Lili activo con imágenes' });
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (msg) handleMessage(msg.from, msg.text?.body || '');
});

// ==================== MAIN HANDLER ====================
async function handleMessage(to, text) {
  const lower = text.toLowerCase().trim();
  
  if (!conversationHistory[to]) {
    conversationHistory[to] = [];
  }
  conversationHistory[to].push({ role: 'user', text, timestamp: new Date() });
  
  const response = generateResponse(to, lower);
  const image = getImageForResponse(to, lower);
  
  // Enviar imagen si corresponde
  if (image) {
    await sendImage(to, image);
    await new Promise(r => setTimeout(r, 800)); // pausa para que meta procese
  }
  
  // Enviar mensaje
  await sendMsg(to, response);
  conversationHistory[to].push({ role: 'agent', text: response, timestamp: new Date() });
}

// ==================== GET IMAGE (ROTACIÓN ALEATORIA) ====================
function getImageForResponse(to, lower) {
  let images = null;
  
  if (lower.includes('escritorio') && lower.includes('flotante')) {
    images = IMAGES.escritorio;
  } else if (lower.includes('repisa')) {
    images = IMAGES.repisas;
  } else if (lower.includes('mesa auxiliar')) {
    images = IMAGES.mesaAuxiliar;
  } else if (lower.includes('escritorio') && !lower.includes('flotante')) {
    images = IMAGES.escritorioNormal;
  } else if (lower.includes('mesa de centro') || lower.includes('jardinera')) {
    images = IMAGES.mesaCentro;
  } else if (lower.includes('recibidor') || lower.includes('banco')) {
    images = IMAGES.recibidor;
  } else if (lower.includes('cama')) {
    images = IMAGES.cama;
  }
  
  if (!images) return null;
  return images[Math.floor(Math.random() * images.length)];
}

// ==================== GENERATE RESPONSE ====================
function generateResponse(to, lower) {
  const history = conversationHistory[to] || [];
  const messageCount = history.length;

  // SALUDO INICIAL
  if ((lower.includes('hola') || lower.includes('hi') || lower.includes('buenos')) && messageCount <= 2) {
    return `¡Hola! 😊 Soy Lili, diseño y fabrico cada pieza en roble macizo.\n\n¿Qué tipo de mueble te interesa?\n- Escritorio Flotante\n- Repisas Flotantes\n- Mesa Auxiliar\n- Recibidor\n- Cama\n- Mesa de Centro\n\nCuéntame un poco sobre qué necesitas 🪵`;
  }

  // ========== ESCRITORIO FLOTANTE ==========
  if (lower.includes('escritorio') && lower.includes('flotante')) {
    if (messageCount <= 3) {
      return `✨ El Escritorio Flotante es una pieza sólida en roble alistonado macizo (no aglomerado).\n\nMedidas: 75 cm ancho × 46.5 cm profundo × 15 cm alto\nTiene cajón frontal con cierre lento y esquinas redondeadas a mano.\n\nCada pieza es única por la veta natural del roble.\n\n¿Para qué espacio lo estás buscando? (home office, dormitorio, sala…) 🪵`;
    } else if (messageCount <= 5) {
      return `¡Excelente! Con una foto de tu espacio y las medidas exactas del muro, diseño tu escritorio personalizado.\n\n**Precio:** $1.590.000\n**Tiempo:** 12 a 15 días hábiles\n**Instalación:** Incluida en Medellín\n\n¿Puedes enviar una foto y decirme el ancho disponible? 😊`;
    } else {
      return `Perfecto 😊 Estoy acá para guiarte en cada paso. Cuando tengas la foto y las medidas, hacemos la cotización exacta.\n\n¿Hay algo más que necesites saber? 🪵`;
    }
  }

  // ========== REPISAS FLOTANTES ==========
  if (lower.includes('repisa') || lower.includes('repisas')) {
    if (messageCount <= 3) {
      return `🪵 Las Repisas Flotantes son roble alistonado macizo con soportes invisibles para que se vean completamente limpias.\n\n15 cm de profundidad, 3 cm de espesor.\n\n**Medidas disponibles:**\n• 60 cm → $220.000\n• 80 cm → $260.000\n• 100 cm → $320.000\n• 120 cm → $380.000\n\nTiempo de entrega: 5-6 días hábiles\n\n¿En qué espacio las quieres? (sala, dormitorio, escritorio…) 😊`;
    } else if (lower.includes('precio') || lower.includes('costo')) {
      return `Claro 😊 Los valores que te pasé son por repisa individual (60, 80, 100 o 120 cm).\n\nSi quieres instalarlas en Medellín: $30.000-$50.000 por repisa.\n\n¿Cuántas necesitas y en qué medida? Así te paso el total exacto 🪵`;
    } else if (lower.includes('envio') || lower.includes('envío')) {
      return `Sí, enviamos a todo Colombia 📦\n\nLas repisas son fáciles de enviar y el costo suele ser bajo (por el tamaño y peso).\n\n¿A qué ciudad sería? Así te cotizo exacto 😊`;
    } else {
      return `Cualquier pregunta sobre medidas, material o tiempos, aquí estoy para acompañarte.\n\n¿Hay algo más? 🪵`;
    }
  }

  // ========== MESA AUXILIAR ==========
  if (lower.includes('mesa auxiliar')) {
    if (messageCount <= 3) {
      return `✨ La Mesa Auxiliar es roble alistonado macizo con patas desmontables.\n\nMedidas: 35 cm ancho × 45 cm profundo × 50 cm alto\n\n**Precio:** $420.000\n**Tiempo:** 8 días hábiles\n\nLas patas son desmontables (se arman en minutos), así el envío es más económico y fácil de recibir.\n\n¿La estás pensando para sala, balcón, o mesita de noche? 😊`;
    } else if (lower.includes('desmontable') || lower.includes('armar') || lower.includes('montar')) {
      return `Exacto 😊 Las patas van con perno y tornillo oculto. Incluye llave y guía visual simple.\n\nSe arma en 5 minutos, sin complicaciones.\n\nEso hace que el envío sea mucho más práctico y accesible en precio 🪵`;
    } else {
      return `¿Te gustaría confirmar el pedido o tienes más preguntas? Estoy acá para ayudarte 😊`;
    }
  }

  // ========== RECIBIDOR ==========
  if (lower.includes('recibidor') || lower.includes('banco')) {
    if (messageCount <= 3) {
      return `🚪 El Recibidor es roble alistonado con cajón y cojín incluido.\n\nMedidas: 96 cm largo × 30 cm profundidad × 40 cm alto\n\n**Precio:** $2.100.000\n**Tiempo:** 15 días hábiles\n\nPerfecto para entrada: guarda cosas sin saturar el espacio visualmente.\n\n¿Lo estás pensando para entrada o para otra zona? ¿Sabes cuánto mide el muro? 😊`;
    } else if (lower.includes('medida') || lower.includes('cm') || lower.includes('metros')) {
      return `Perfecto 😊 Si tienes aproximadamente 1 metro disponible, la medida estándar funciona ideal.\n\nSi es menos, también podemos ajustarla y recalcular el valor.\n\nCuéntame tu medida exacta para confirmarte todo 🪵`;
    } else {
      return `Estoy acá para resolver cualquier duda. ¿Hay algo más que quieras saber? 😊`;
    }
  }

  // ========== MESA DE CENTRO ==========
  if (lower.includes('mesa de centro') || lower.includes('jardinera')) {
    if (messageCount <= 3) {
      return `✨ La Mesa de Centro con Jardinera es roble alistonado macizo, una pieza protagonista.\n\nMedidas: 140 cm × 120 cm\n\n**Precio:** $4.200.000\n**Tiempo:** 20 a 25 días hábiles\n\nTambién se puede fabricar en medidas menores con ajuste proporcional de precio.\n\n¿La estás buscando para un espacio de qué tamaño aproximadamente? 😊`;
    } else if (lower.includes('medida') || lower.includes('espacio') || lower.includes('compacta')) {
      return `¡Excelente! Con ese dato podemos diseñarla perfecta para tu sala.\n\nSi el espacio es más compacto, ajustamos dimensiones y recalculamos el valor.\n\n¿Cuáles serían las medidas máximas disponibles? 🪵`;
    } else {
      return `Cualquier pregunta o si quieres empezar el diseño, avísame 😊`;
    }
  }

  // ========== CAMA ==========
  if (lower.includes('cama')) {
    if (messageCount <= 3) {
      return `🛏️ Las Camas son roble alistonado macizo con diseño minimalista y duradero.\n\n**Versión Queen:**\n- Respaldo listonado: $8.700.000\n- Respaldo liso: $8.200.000\n\n**Tiempo:** 4 a 6 semanas\n**También disponible:** Tamaño Doble o King\n\n¿Qué tamaño necesitas y cuál estilo de respaldo? 😊`;
    } else {
      return `Perfecto 😊 Con esa información diseño tu cama personalizada.\n\n¿Quieres respaldo listonado (con vetas visibles) o liso? 🪵`;
    }
  }

  // ========== PRECIO (SIN CONTEXTO) ==========
  if ((lower.includes('precio') || lower.includes('costo') || lower.includes('valor')) && messageCount <= 3) {
    return `Claro 😊 Los precios dependen del producto.\n\n¿Cuál te interesa?\n- Escritorio Flotante: $1.590.000\n- Repisas: desde $220.000\n- Mesa Auxiliar: $420.000\n- Recibidor: $2.100.000\n- Cama Queen: desde $8.200.000\n- Mesa de Centro: $4.200.000\n\n¿Alguno de estos? Cuéntame un poco 🪵`;
  }

  // ========== "ESTÁ CARO" ==========
  if (lower.includes('caro') || lower.includes('precio alto') || lower.includes('muy caro')) {
    return `Entiendo 😊\n\nEl precio refleja roble macizo auténtico (no MDF), construcción artesanal a mano, y durabilidad de 20+ años.\n\nNo es producción masiva. Cada pieza es única por las vetas naturales.\n\nEs una inversión en una pieza que te acompaña para siempre, no un gasto que tengas que reemplazar en 2 años 🪵\n\n¿Hay algo específico que quieras conocer más?`;
  }

  // ========== MATERIAL ==========
  if (lower.includes('material') || lower.includes('roble') || lower.includes('madera') || lower.includes('mdf')) {
    return `🪵 Todos los productos son roble alistonado macizo.\n\nNo es MDF ni enchapado. Se siente más sólido, pesa más, y envejece mejor con el tiempo. Cada veta es única.\n\nEs madera que perdura décadas 😊\n\n¿Hay algo más que quieras saber?`;
  }

  // ========== INSTALACIÓN ==========
  if (lower.includes('instalacion') || lower.includes('instalación') || lower.includes('instalar')) {
    return `✅ La instalación está incluida en zona urbana de Medellín (corre por mi cuenta).\n\nPara otras ciudades:\n📦 Enviamos con empaque reforzado\n📖 Te doy instrucciones detalladas\n✨ Disponible asesoría virtual\n\n¿Dónde estás? 😊`;
  }

  // ========== TIEMPO ENTREGA ==========
  if ((lower.includes('tiempo') || lower.includes('cuanto tarda') || lower.includes('dias') || lower.includes('días')) && messageCount > 2) {
    if (lower.includes('repisa')) {
      return `Las Repisas las entrego en 5 a 6 días hábiles 📦\n\nSon tiempos cortos porque las fabrico de forma continua 😊`;
    } else if (lower.includes('mesa auxiliar')) {
      return `La Mesa Auxiliar la entrego en aproximadamente 8 días 📦\n\nTiempos cortos porque la estoy produciendo continuamente 😊`;
    } else if (lower.includes('escritorio') && lower.includes('flotante')) {
      return `El Escritorio Flotante tarda 12 a 15 días hábiles 📦\n\nDesde que confirmas el diseño hasta la instalación incluida 🪵`;
    } else if (lower.includes('recibidor')) {
      return `El Recibidor tarda 15 días hábiles 📦\n\nDesde confirmación hasta entrega 🪵`;
    } else {
      return `Los tiempos varían según el producto. ¿Cuál te interesa? Así te doy el tiempo exacto 😊`;
    }
  }

  // ========== CONSULTA GENÉRICA ==========
  return `¡Buena pregunta! 😊\n\nPara ayudarte mejor:\n- ¿Cuál mueble te interesa?\n- ¿Qué espacio quieres transformar?\n- ¿Ya tienes medidas o necesitas ayuda?\n\nEstoy acá para guiarte en todo el proceso. No estás solo 🪵`;
}

// ==================== SEND IMAGE ====================
async function sendImage(to, imageUrl) {
  const token = (META_API_TOKEN || '').trim();
  console.log(`[sendImage] token presente: ${!!token}, longitud: ${token.length}`);
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { link: imageUrl }
    }, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`✅ Imagen enviada a ${to}`);
  } catch (e) {
    console.error('❌ Error enviando imagen — status:', e.response?.status);
    console.error('❌ Error enviando imagen — data:', JSON.stringify(e.response?.data, null, 2));
    console.error('❌ Error enviando imagen — message:', e.message);
  }
}

// ==================== SEND MESSAGE ====================
async function sendMsg(to, text) {
  const token = (META_API_TOKEN || '').trim();
  console.log(`[sendMsg] token presente: ${!!token}, longitud: ${token.length}`);
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`✅ Mensaje enviado a ${to}`);
  } catch (e) {
    console.error('❌ Error enviando mensaje — status:', e.response?.status);
    console.error('❌ Error enviando mensaje — data:', JSON.stringify(e.response?.data, null, 2));
    console.error('❌ Error enviando mensaje — message:', e.message);
  }
}

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`✅ Agente Lili con imágenes en puerto ${PORT}`);

  // Validación y debug de variables de entorno al iniciar
  if (!META_API_TOKEN) {
    console.error('❌ ERROR: META_API_TOKEN no está definido. El agente no podrá enviar mensajes.');
  } else {
    console.log(`🔑 META_API_TOKEN cargado correctamente (longitud: ${META_API_TOKEN.length} caracteres)`);
  }

  if (!PHONE_NUMBER_ID) {
    console.error('❌ ERROR: PHONE_NUMBER_ID no está definido. El agente no podrá enviar mensajes.');
  } else {
    console.log(`📱 PHONE_NUMBER_ID cargado correctamente (longitud: ${PHONE_NUMBER_ID.length} caracteres)`);
  }
});
module.exports = app;
