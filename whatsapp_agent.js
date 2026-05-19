/**
 * AGENTE WHATSAPP - HECHO POR LILI
 * 
 * Este agente:
 * 1. Recibe mensajes desde Meta Cloud API
 * 2. Califica leads automáticamente
 * 3. Responde según el patrón de Lili
 * 4. Escala a Lili si es necesario
 * 5. Aprende y mejora con cada conversación
 */

const express = require('express');
const axios = require('axios');
const app = express();

// ==================== CONFIGURACIÓN ====================
const META_API_TOKEN = process.env.META_API_TOKEN || "TU_TOKEN_AQUI";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "TU_PHONE_ID";
const WABA_ID = process.env.WABA_ID || "TU_WABA_ID";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "hecho_por_lili_2026";

// Base de datos simple de leads (en producción usar MongoDB/Firebase)
const leadsDatabase = {};
const conversationHistory = {};

// ==================== CONFIGURACIÓN DE PRODUCTOS ====================
const PRODUCTOS = {
  escritorio_flotante: {
    nombre: "Escritorio Flotante",
    medida_std: "75 x 46 cm",
    precio: 1590000,
    tiempo: "10 días",
    descripcion: "Roble natural alistonado con cajón cierre lento e instalación incluida",
    features: ["Roble macizo", "Cajón soft-close", "Bordes redondeados", "Instalación incluida"]
  },
  repisa_flotante: {
    nombre: "Repisa Flotante",
    medida_std: "60 cm",
    precio: 220000,
    tiempo: "10 días",
    descripcion: "Roble alistonado de 3 cm de espesor, instalación flotante incluida",
    features: ["Roble macizo", "3 cm espesor", "Instalación incluida"]
  },
  tocador: {
    nombre: "Tocador Flotante",
    medida_std: "130 x 50 cm (a medida)",
    precio: 1750000,
    tiempo: "12 días",
    descripcion: "Roble natural con cajón soft-close y anclajes profesionales",
    features: ["Roble macizo", "Cajón soft-close", "Personalizable", "Instalación incluida"]
  }
};

// ==================== CLAUDE API INTEGRATION ====================
async function analizarMensajeConClaude(mensaje, historiaConversacion) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `Eres un agente de atención al cliente para Hecho por Lili, una marca de muebles artesanales en roble macizo.

INSTRUCCIONES CRÍTICAS:
1. Siempre eres Lili, la diseñadora y fundadora
2. Cuando pregunta por un producto: PRIMERO pide foto/medidas del espacio, DESPUÉS das precio
3. Si dice "caro" o precio: explicas que es inversión a largo plazo, NO bajas precio
4. Maneja objeciones con DATA: gatos que se suben, clientes reales, durabilidad
5. Si es proyecto/futuro: da info pero NO presiones, dile que contacte cuando esté listo
6. Tone: cálido, breve, directo. Usa emojis moderadamente (😊✨👌)
7. Si la pregunta es muy compleja o custom: di "quiero revisarlo con cuidado, dame unas horas"

REGLAS DE ESCALADA A LILI:
- Proyecto VERY custom (arquitectura compleja, varios muebles, medidas raras)
- Cliente dice "hablar con Lili directamente"
- Lead muy caliente (ya casi cierra)
- Cotización por encima de $3.000.000

FLUJO ESTÁNDAR:
1. Saludo: "¡Hola! Soy Lili..."
2. Pregunta abierta sobre el espacio
3. SI pide precio antes de foto: responde pero insiste en foto
4. Con medidas: da cotización
5. Si hay objeción: maneja con empatía + datos
6. Cierre: propuesta clara + pasos siguientes`,
        messages: [
          ...historiaConversacion.map(msg => ({
            role: msg.role,
            content: msg.content
          })),
          {
            role: "user",
            content: mensaje
          }
        ]
      })
    });

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error("Error en Claude API:", error);
    return null;
  }
}

// ==================== CALIFICACIÓN DE LEADS ====================
function calificarLead(mensajes) {
  let temperatura = "frio"; // frío, tibio, caliente
  let etapa = "inicial";
  let producto_interes = null;
  
  const textoCompleto = mensajes.map(m => m.text.toLowerCase()).join(" ");
  
  // Detectar producto
  if (textoCompleto.includes("escritorio")) producto_interes = "escritorio_flotante";
  if (textoCompleto.includes("repisa")) producto_interes = "repisa_flotante";
  if (textoCompleto.includes("tocador")) producto_interes = "tocador";
  
  // Detectar etapa
  if (textoCompleto.includes("cotización") || textoCompleto.includes("presupuesto")) etapa = "cotizado";
  if (textoCompleto.includes("medida") || textoCompleto.includes("espacio")) etapa = "calificado";
  if (textoCompleto.includes("gracias por la info") || textoCompleto.includes("voy a pensar")) etapa = "en_pausa";
  
  // Temperatura
  const mensajes_count = mensajes.length;
  const tiene_foto = textoCompleto.includes("[foto]") || textoCompleto.includes("mando foto");
  const tiene_medidas = /\d+\s*(cm|x)/i.test(textoCompleto);
  const usa_terminos_urgentes = textoCompleto.includes("rápido") || textoCompleto.includes("pronto") || textoCompleto.includes("urgente");
  
  if (etapa === "cotizado" && tiene_medidas) temperatura = "caliente";
  else if (etapa === "calificado" && (tiene_foto || tiene_medidas)) temperatura = "tibio";
  else if (mensajes_count > 3 && etapa !== "en_pausa") temperatura = "tibio";
  else temperatura = "frio";
  
  return {
    temperatura,
    etapa,
    producto_interes,
    requiere_escalada: temperatura === "caliente" && etapa === "cotizado"
  };
}

// ==================== ENDPOINTS ====================

// Verificar webhook (Meta lo requiere)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recibir mensajes de Meta
app.post("/webhook", express.json(), async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Extraer mensaje
    const message = value.messages?.[0];
    const sender = message?.from;
    const texto = message?.text?.body;
    const messageId = message?.id;

    if (sender && texto) {
      console.log(`📱 Nuevo mensaje de ${sender}: ${texto}`);

      // Inicializar lead si no existe
      if (!leadsDatabase[sender]) {
        leadsDatabase[sender] = {
          telefono: sender,
          primer_mensaje: new Date(),
          mensajes: [],
          estado: "nuevo",
          temperatura: "frio"
        };
        conversationHistory[sender] = [];
      }

      // Guardar mensaje
      leadsDatabase[sender].mensajes.push({
        timestamp: new Date(),
        text: texto,
        role: "user"
      });

      conversationHistory[sender].push({
        role: "user",
        content: texto
      });

      try {
        // Analizar con Claude
        const respuesta = await analizarMensajeConClaude(
          texto,
          conversationHistory[sender]
        );

        if (respuesta) {
          // Calificar lead
          const diagnostico = calificarLead(leadsDatabase[sender].mensajes);
          leadsDatabase[sender].temperatura = diagnostico.temperatura;
          leadsDatabase[sender].etapa = diagnostico.etapa;
          leadsDatabase[sender].producto = diagnostico.producto_interes;

          // Guardar respuesta en historial
          conversationHistory[sender].push({
            role: "assistant",
            content: respuesta
          });

          // Enviar respuesta a WhatsApp
          await enviarMensajeWhatsApp(sender, respuesta, messageId);

          // Si requiere escalada: notificar a Lili
          if (diagnostico.requiere_escalada) {
            await notificarEscalada(sender, diagnostico);
          }

          console.log(`✅ Respuesta enviada a ${sender}`);
          console.log(`📊 Lead: ${diagnostico.temperatura} - ${diagnostico.etapa}`);
        }
      } catch (error) {
        console.error("Error procesando mensaje:", error);
        // Respuesta de fallback
        await enviarMensajeWhatsApp(
          sender,
          "Hola 😊 Gracias por tu mensaje. Estoy procesando tu consulta. En breve te respondo con más detalle.",
          messageId
        );
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Enviar mensaje por WhatsApp
async function enviarMensajeWhatsApp(telefono, mensaje, replyToId = null) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: {
        preview_url: false,
        body: mensaje
      }
    };

    // Si es respuesta a un mensaje
    if (replyToId) {
      payload.context = {
        message_id: replyToId
      };
    }

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${META_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    return response.data;
  } catch (error) {
    console.error("Error enviando mensaje:", error.response?.data || error.message);
    throw error;
  }
}

// Notificar a Lili cuando hay escalada
async function notificarEscalada(telefono, diagnostico) {
  const lead = leadsDatabase[telefono];
  const ultimoMensaje = lead.mensajes[lead.mensajes.length - 1]?.text || "";

  const notificacion = `
🚨 ESCALADA REQUERIDA

📞 Cliente: ${telefono}
🏷️ Producto: ${diagnostico.producto_interes || "No especificado"}
📍 Estado: ${diagnostico.etapa}
🔥 Temperatura: ${diagnostico.temperatura}

Último mensaje: "${ultimoMensaje}"

⚠️ El agente ha procesado esta conversación, pero por la complejidad o el avance del lead, es mejor que Lili continúe.

Acciones sugeridas:
1. Revisar la conversación completa
2. Conectar directamente con el cliente
3. Si está muy caliente: cerrar la venta hoy
  `;

  console.log(notificacion);
  // En producción: enviar email a Lili o notificación en Slack
}

// Dashboard simple: ver leads
app.get("/leads", (req, res) => {
  const leadsSummary = Object.entries(leadsDatabase).map(([phone, data]) => ({
    telefono: phone,
    primer_contacto: data.primer_mensaje,
    temperatura: data.temperatura,
    producto: data.producto,
    etapa: data.etapa,
    ultimos_mensajes: data.mensajes.slice(-2).map(m => m.text)
  }));

  res.json({
    total_leads: leadsSummary.length,
    calientes: leadsSummary.filter(l => l.temperatura === "caliente").length,
    tibios: leadsSummary.filter(l => l.temperatura === "tibio").length,
    frios: leadsSummary.filter(l => l.temperatura === "frio").length,
    leads: leadsSummary
  });
});

// Ver conversación completa de un lead
app.get("/leads/:phone", (req, res) => {
  const phone = req.params.phone;
  const lead = leadsDatabase[phone];

  if (!lead) {
    return res.status(404).json({ error: "Lead no encontrado" });
  }

  res.json({
    ...lead,
    historial_completo: conversationHistory[phone]
  });
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     🪵 HECHO POR LILI - AGENTE ACTIVO 🪵    ║
╚════════════════════════════════════════════╝

✅ Servidor escuchando en puerto ${PORT}
✅ Webhook en: /webhook
✅ Dashboard en: /leads
✅ Conversaciones en: /leads/:telefono

⚙️  Próximos pasos:
1. Configura las variables de entorno:
   - META_API_TOKEN (tu token de Meta)
   - PHONE_NUMBER_ID (tu ID de WhatsApp)
   - WABA_ID (tu Workspace ID)

2. En Meta Cloud API, configura el webhook:
   - URL: tu-dominio.com/webhook
   - Verify Token: hecho_por_lili_2026
   - Subscribe: messages

3. El agente está listo para recibir mensajes 🚀
  `);
});

module.exports = app;
