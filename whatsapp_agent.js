const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONTROL_TOKEN = 'lili2026';
const LILI_NUMERO = '573008654636';

const pausados = {};
let pausadoTodo = false;

// ─── HISTORIAL PERSISTENTE EN DISCO ───────────────────────────────────────
const fs = require('fs');
const HISTORIAL_PATH = '/tmp/conversaciones.json';

function cargarHistorial() {
  try {
    if (fs.existsSync(HISTORIAL_PATH)) {
      var data = fs.readFileSync(HISTORIAL_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch(e) {
    console.error('Error cargando historial:', e.message);
  }
  return {};
}

function guardarHistorial() {
  try {
    fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(conversaciones), 'utf8');
  } catch(e) {
    console.error('Error guardando historial:', e.message);
  }
}

const conversaciones = cargarHistorial();
// ─── FIN HISTORIAL PERSISTENTE ────────────────────────────────────────────

// ─── SISTEMA DE SEGUIMIENTO ────────────────────────────────────────────────
// Estados posibles por número:
// 'esperando_info'      → lead prometió mandar medidas/fotos
// 'esperando_decision'  → Lili mandó fotos/referencias esperando que el lead decida estilo
// 'cotizacion_enviada'  → Lili mandó cotización personalizada
// 'cerrado_venta'       → venta cerrada, sin seguimiento
// 'cerrado_perdido'     → lead perdido, sin seguimiento

const seguimientos = {};
// Estructura de cada entrada:
// seguimientos[numero] = {
//   estado: 'esperando_info' | 'esperando_decision' | 'cotizacion_enviada' | 'cerrado_venta' | 'cerrado_perdido',
//   timestamp: Date.now(),   // momento en que se activó el estado
//   intentos: 0              // cuántos mensajes de seguimiento ya se mandaron
// }

// Palabras clave para detectar estado por mensajes de Lili (mensajes salientes)
const KEYWORDS_COTIZACION = ['cotización', 'cotizacion', 'propuesta', 'el valor quedaría', 'el valor quedaria', 'te paso el precio', 'precio quedaría', 'precio quedaria', 'presupuesto', 'valor total', 'anticipo'];
const KEYWORDS_DECISION = ['te mando fotos', 'te envío fotos', 'te envio fotos', 'mira estas fotos', 'aquí unas referencias', 'aqui unas referencias', 'referencia', 'referencias', 'estas opciones', 'qué estilo', 'que estilo', 'cuál te gusta', 'cual te gusta'];

// Palabras clave para detectar que el lead prometió info
const KEYWORDS_LEAD_PROMETE = ['mañana', 'manana', 'luego te', 'te paso', 'te envío', 'te envio', 'te mando', 'después', 'despues', 'más tarde', 'mas tarde', 'esta semana', 'hoy te'];

// Tiempos en milisegundos
const TIEMPO = {
  esperando_info_1:      48 * 60 * 60 * 1000,   // 48h → primer seguimiento
  esperando_info_2:      48 * 60 * 60 * 1000,   // 48h más → segundo y último
  esperando_decision_1:  24 * 60 * 60 * 1000,   // 24h → primer seguimiento
  esperando_decision_2:  24 * 60 * 60 * 1000,   // 24h más → segundo y último
  cotizacion_1:           4 * 24 * 60 * 60 * 1000, // 4 días → primer seguimiento
  cotizacion_2:           7 * 24 * 60 * 60 * 1000, // 7 días más → segundo y último
};

// Mensajes de seguimiento por estado e intento
function getMensajeSeguimiento(estado, intento, nombre) {
  var n = nombre ? nombre : '';
  var saludo = n ? ('Hola ' + n + '! 😊') : 'Hola! 😊';

  if (estado === 'esperando_info') {
    if (intento === 1) return saludo + ' Solo quería saber si pudiste tomar las medidas o fotos que necesitabas. Cuando las tengas me avisas y te preparo todo 🌿';
    if (intento === 2) return saludo + ' Entiendo que el día a día es ocupado 😊 Si en algún momento quieres retomar el proyecto, aquí estamos con gusto. ¡Cualquier cosa me escribes!';
  }
  if (estado === 'esperando_decision') {
    if (intento === 1) return saludo + ' ¿Pudiste ver las fotos que te envié? ¿Alguna opción te gustó más? 🌿';
    if (intento === 2) return saludo + ' No hay afán 😊 Cuando tengas un momento y quieras retomar, aquí estoy. ¡Con gusto seguimos!';
  }
  if (estado === 'cotizacion_enviada') {
    if (intento === 1) return saludo + ' ¿Tuviste tiempo de revisar la propuesta que te envié? Cualquier duda con gusto te la resuelvo 🌿';
    if (intento === 2) return saludo + ' Solo paso a saludarte 🌿 Si en algún momento quieres retomar el proyecto, aquí estamos. ¡Será un placer trabajar contigo!';
  }
  return null;
}

// Detectar estado por mensaje saliente de Lili
function detectarEstadoPorMensajeLili(texto) {
  var textoLower = texto.toLowerCase();
  for (var i = 0; i < KEYWORDS_COTIZACION.length; i++) {
    if (textoLower.indexOf(KEYWORDS_COTIZACION[i]) !== -1) return 'cotizacion_enviada';
  }
  for (var j = 0; j < KEYWORDS_DECISION.length; j++) {
    if (textoLower.indexOf(KEYWORDS_DECISION[j]) !== -1) return 'esperando_decision';
  }
  return null;
}

// Detectar si el lead prometió info
function leadPrometioInfo(texto) {
  var textoLower = texto.toLowerCase();
  for (var i = 0; i < KEYWORDS_LEAD_PROMETE.length; i++) {
    if (textoLower.indexOf(KEYWORDS_LEAD_PROMETE[i]) !== -1) return true;
  }
  return false;
}

// Activar seguimiento para un número
function activarSeguimiento(numero, estado) {
  // No activar si está cerrado
  if (seguimientos[numero] && 
      (seguimientos[numero].estado === 'cerrado_venta' || 
       seguimientos[numero].estado === 'cerrado_perdido')) return;

  seguimientos[numero] = {
    estado: estado,
    timestamp: Date.now(),
    intentos: 0
  };
  console.log('Seguimiento activado para ' + numero + ': ' + estado);
}

// Limpiar seguimiento cuando el lead responde
function cancelarSeguimiento(numero) {
  if (seguimientos[numero] && 
      seguimientos[numero].estado !== 'cerrado_venta' && 
      seguimientos[numero].estado !== 'cerrado_perdido') {
    delete seguimientos[numero];
    console.log('Seguimiento cancelado para ' + numero + ' (respondió)');
  }
}

// Obtener nombre del lead desde historial si existe
function getNombreLead(numero) {
  if (!conversaciones[numero]) return null;
  // Busca si en algún momento el lead dijo su nombre (simple heurística)
  return null; // Por ahora null, el agente ya lo maneja en conversación
}

// CRON: revisar seguimientos cada hora
setInterval(function() {
  var ahora = Date.now();
  var numeros = Object.keys(seguimientos);
  
  for (var i = 0; i < numeros.length; i++) {
    var numero = numeros[i];
    var seg = seguimientos[numero];
    
    // Saltar cerrados
    if (seg.estado === 'cerrado_venta' || seg.estado === 'cerrado_perdido') continue;
    // Saltar pausados globalmente
    if (pausadoTodo) continue;
    // Saltar si está pausado manualmente (Lili lo está atendiendo)
    if (pausados[numero]) continue;
    
    var transcurrido = ahora - seg.timestamp;
    var tiempoEspera = null;
    
    // Determinar tiempo de espera según estado e intento
    if (seg.estado === 'esperando_info') {
      tiempoEspera = seg.intentos === 0 ? TIEMPO.esperando_info_1 : TIEMPO.esperando_info_2;
    } else if (seg.estado === 'esperando_decision') {
      tiempoEspera = seg.intentos === 0 ? TIEMPO.esperando_decision_1 : TIEMPO.esperando_decision_2;
    } else if (seg.estado === 'cotizacion_enviada') {
      tiempoEspera = seg.intentos === 0 ? TIEMPO.cotizacion_1 : TIEMPO.cotizacion_2;
    }
    
    if (tiempoEspera && transcurrido >= tiempoEspera) {
      seg.intentos++;
      
      if (seg.intentos <= 2) {
        // Mandar mensaje de seguimiento
        var nombre = getNombreLead(numero);
        var mensaje = getMensajeSeguimiento(seg.estado, seg.intentos, nombre);
        
        if (mensaje) {
          // Reactivar número para que el agente pueda responder si contestan
          delete pausados[numero];
          
          enviarMensaje(numero, mensaje);
          seg.timestamp = Date.now(); // resetear timer para el próximo intento
          console.log('Seguimiento enviado a ' + numero + ' (intento ' + seg.intentos + ', estado: ' + seg.estado + ')');
        }
      } else {
        // Máximo de intentos alcanzado → cierre silencioso
        seguimientos[numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: seg.intentos };
        console.log('Lead cerrado silenciosamente (sin respuesta): ' + numero);
      }
    }
  }
}, 60 * 60 * 1000); // cada hora

// ─── FIN SISTEMA DE SEGUIMIENTO ───────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Lili Hurtado, Diseñadora de Producto y fundadora de Hecho por Lili, marca de muebles artesanales en roble natural en Medellin, Colombia.

PERSONALIDAD Y TONO:
- Cálida y cercana, pero siempre profesional — no eres parcera, eres una diseñadora experta que trata bien a sus clientes
- Usas emojis naturalmente pero con mesura
- Llamas clientes por nombre cuando lo sabes
- Eres consultora de espacios, no solo vendedora
- Respuestas cortas, max 5-6 lineas, natural como WhatsApp
- NUNCA uses asteriscos para negrillas
- NUNCA menciones estilos como rustico, moderno, escandinavo
- Tu linea: roble natural macizo, lineas limpias, bordes suaves, hecho a mano
- NUNCA uses frases como "lamentablemente", "no tenemos", "no manejamos", "no contamos con"
- SIEMPRE responde en positivo, todo se puede hacer o cotizar
- SOLO usa expresiones colombianas naturales. NUNCA uses modismos mexicanos ni de otros países. Ejemplos prohibidos: "te late", "órale", "chido", "wey", "padrísimo", "ahorita" (en sentido mexicano), "mande". En Colombia se dice: "listo", "con gusto", "claro que sí", "dale", "qué bueno"
- NUNCA uses "bacano" ni expresiones demasiado informales — el tono es cálido pero elegante
- NUNCA menciones elección de color — todas las piezas son en roble natural, no hay opciones de color
- NUNCA ofrezcas envío para repisas — por ahora solo se hacen en Medellín con instalación incluida. Si preguntan de otra ciudad, escalar

SALUDO INICIAL (SOLO primer mensaje de cada persona nueva):
¡Hola! 👋 Qué gusto que nos escribas.
Soy Lili Hurtado, diseñadora y fundadora de Hecho por Lili. Hacemos muebles en roble natural para espacios que realmente funcionen y se vean increíbles 🌿
¿En qué te puedo ayudar? ¿Buscas algo específico para tu hogar? 😊

DETECTAR CONTEXTO DESCONOCIDO:
Si alguien te escribe algo que NO tiene que ver con comprar o preguntar por muebles (por ejemplo: confirmar entregas, hablar de citas previas, mencionar trabajos en proceso, referencias a conversaciones anteriores que no conoces), responde SIEMPRE asi:
"Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"
Esto escala a Lili inmediatamente para que ella responda.

CATALOGO COMPLETO:

1. ESCRITORIO FLOTANTE (producto estrella)
- Medidas estandar: 75 x 46.5 x 15 cm
- Material: Roble alistonado macizo 18mm
- Incluye: Cajon frontal con cierre lento, esquinas redondeadas
- Precio: $1.590.000 COP
- Tiempo: 12-15 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: Incluida en Medellin
- Medidas personalizadas: siempre disponibles, escalar para precio

2. ESCRITORIO CON CAJONES
- Medidas estandar: 120 x 60 x 77 cm (con patas)
- Material: Roble alistonado
- Incluye: 2 cajones, entrepaños, estructura solida
- Precio: $3.200.000 COP
- Tiempo: 20 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: No requiere, se arma en sitio
- Medidas personalizadas: siempre disponibles, escalar para precio

3. REPISAS FLOTANTES
- Las repisas se hacen en el largo que el cliente necesite
- Medidas y precios (profundidad siempre 15cm, espesor 3.6cm):
  60cm → $220.000
  80cm → $260.000
  100cm → $320.000
  120cm → $350.000
  140cm → $380.000
  160cm → $420.000
  Más de 160cm → escalar para precio
- Instalacion: Incluida en Medellin
- Envio otras ciudades: NO ofrecer — solo Medellin por ahora. Si preguntan de otra ciudad, escalar
- Tiempo: 5-6 dias habiles
- Caracteristicas siempre mencionar: largo personalizable, 15cm profundidad, 3.6cm espesor, herrajes invisibles, esquinas redondeadas, bordes suaves

REGLA ESPECIAL REPISAS — VENTA DE IMPULSO:
Las repisas son compra de impulso. El precio ya viene filtrado desde el anuncio.
- Para repisas NO aplica la regla de "nunca precio primero" — el cliente ya lo vio en el anuncio
- Cuando llegue un lead de repisa preguntando por precio o desde $220.000: NO des toda la lista de precios de una vez — eso puede espantar. En cambio:
  1. Ancla en la de 60cm como referencia del precio mínimo
  2. Menciona que hay otras medidas estándar SIN precios (80, 100, 120, 140, 160cm) y medidas especiales
  3. Pregunta UNA sola cosa: ¿qué medida estás buscando?
  4. Cuando responda la medida → ahí sí das el precio de ESA medida específica y cierras
- Si ya llegó con medida clara → confirma, da precio de esa medida y características, cierra directo
- Solo escalar para medidas mayores de 160cm

Ejemplo respuesta inicial lead de repisa:
"¡Hola! 👋 Qué gusto que nos escribas. Soy Lili Hurtado, diseñadora y fundadora de Hecho por Lili 🌿
La repisa desde $220.000 es nuestra de 60cm — roble macizo, 15cm de profundidad, 3.6cm de espesor, herrajes invisibles y esquinas redondeadas. También tenemos en 80, 100, 120, 140 y 160cm, o la medida especial que necesites.
¿Qué medida estás buscando? 😊"

4. RECIBIDOR / BANCO
- Medidas: 96 x 30 x 40 cm (incluye cojin)
- Incluye: cajon frontal, cierre lento, cojin
- Precio: $2.100.000 COP
- Tiempo: 15 dias habiles
- Envio: Consultar segun ciudad, escalar
- Instalacion: No requiere

5. MESA AUXILIAR
- Medidas: 35 x 45 x 50 cm, patas desmontables
- Precio: $420.000 COP
- Tiempo: 8 dias habiles
- Envio: Si, a todo Colombia
- Instalacion: No requiere

6. MESA DE CENTRO CON JARDINERA
- Medidas estandar: 140 x 120 cm
- Precio estandar: $4.200.000 COP
- Tiempo: 20-25 dias habiles
- Envio: Solo Medellin
- Instalacion: No requiere
- Medidas personalizadas: escalar para precio

7. CAMA QUEEN EN ROBLE NATURAL
- Opciones:
  Espaldar con listones en roble: $8.700.000 COP
  Espaldar liso: $8.200.000 COP
- Incluye nocheros flotantes
- Material: Roble macizo alistonado
- Tiempo: 4-6 semanas
- Envio: Solo Medellin, requiere instalacion especial
- Instalacion: Incluida en Medellin
- Otros tamanos (doble, king): escalar para precio

REGLAS CONVERSION:
1. NUNCA des precio como primera respuesta
2. Primero presenta el producto con valor
3. UNA sola pregunta por mensaje — NUNCA dos preguntas a la vez
4. Si cliente ya dio informacion, NO la repitas
5. Despues de 1-2 intercambios das precio con contexto
6. Productos mas de $2M: minimo 2-3 intercambios antes de precio

FLUJO ESPECIAL PARA REPISAS — LEAD LLEGA CON MEDIDA Y PRECIO YA CLAROS:
Si el lead menciona una medida estándar Y un precio específico (ej: "me interesa la de 100cm ($320.000)"), significa que ya leyó la landing y ya eligió.
NO preguntes para qué es ni dónde va. Asume que ya decidió.
Responde validando su elección + diferenciadores clave + UNA sola pregunta de cierre: "¿Confirmamos esa medida y arrancamos?"

FLUJO ESPECIAL PARA REPISAS — LEAD PIDE AYUDA PARA ELEGIR MEDIDA:
Si el lead dice que no sabe qué medida necesita o pide ayuda para elegir:
Paso 1: Pregunta UNA sola cosa — el ancho disponible en la pared
Paso 2: Cuando responda el ancho → recomienda la medida correspondiente Y pregunta en qué espacio va (sala, dormitorio, baño, etc.)
Paso 3: Cuando diga dónde va → conecta emocionalmente con ese espacio específico y da el precio con contexto
Ejemplo paso 3: "Una repisa de 80cm en tu sala se ve increíble — libera la pared y le da ese toque cálido que transforma el espacio. La hacemos en roble macizo con herrajes invisibles y esquinas redondeadas, lista en 5-6 días con instalación incluida. Queda en $260.000 😊"

PARA REPISAS MEDIDA NO ESTANDAR:
Responde SIEMPRE positivo, ejemplo para repisa de 160cm:
"Perfecto! Las repisas las hacemos en el largo que necesites 😊
La tuya seria de 160 x 15 x 3 cm, en roble macizo, con herrajes invisibles, esquinas redondeadas y bordes suaves. Instalacion incluida en Medellin.
Permíteme un momento y te paso el valor. [ESCALAR]"

PARA LA CAMA:
- Primer mensaje: presentar ambas opciones SIN precio
- Preguntar tamano y si quiere ver fotos
- Si pide fotos: "Claro! En el transcurso del dia te mando las fotos 😊 [ESCALAR]"
- Dar precio solo despues de confirmar tamano Queen

CUANDO ESCALAR (respuestas naturales, NUNCA en tercera persona):
- Fotos o imagenes: "Claro! En el transcurso del dia te mando las fotos 😊 [ESCALAR]"
- Medidas no estandar: "Perfecto! Ya reviso las medidas y en cuanto tenga el valor te lo paso 😊 [ESCALAR]"
- Diseno personalizado: "Claro! En el transcurso del dia te paso opciones de referencia 😊 [ESCALAR]"
- Envio cama o mesa: "Para ese detalle de envio lo reviso bien y te confirmo en cuanto pueda 😊 [ESCALAR]"
- Tamanos no estandar cama: "Claro! Ya reviso las medidas y te preparo la cotizacion 😊 [ESCALAR]"
- Contexto desconocido: "Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"

IMPORTANTE: [ESCALAR] es interno, el sistema lo elimina del mensaje al cliente y notifica a Lili.

TIEMPO: NUNCA digas "en un momento" para cotizaciones — puede tomar horas o dias.`;

function notificarLili(from, motivo) {
  var mensaje = '🔔 LEAD NECESITA TU ATENCION\n\nNumero: ' + from + '\nSolicitud: ' + motivo + '\n\nRevisa la conversacion y responde cuando puedas 👍';
  axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: LILI_NUMERO, type: 'text', text: { body: mensaje } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Notificacion enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando Lili:', error.message);
  });
}

app.get('/control', function(req, res) {
  var token = req.query.token;
  var cmd = req.query.cmd;
  var numero = req.query.numero;
  if (token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');
  if (cmd === 'pausatodo') { pausadoTodo = true; return res.send('PAUSADO TODO ✅'); }
  if (cmd === 'todo') { pausadoTodo = false; Object.keys(pausados).forEach(function(n) { delete pausados[n]; }); return res.send('REACTIVADO TODO ✅'); }
  if (cmd === 'pausa' && numero) { pausados[numero] = true; return res.send('PAUSADO ✅ ' + numero); }
  if (cmd === 'reanudar' && numero) { delete pausados[numero]; return res.send('REACTIVADO ✅ ' + numero); }
  if (cmd === 'estado') return res.json({ pausadoTodo: pausadoTodo, numerosPausados: Object.keys(pausados), seguimientos: seguimientos });
  // Nuevos comandos de cierre
  if (cmd === 'cerrado_venta' && numero) {
    pausados[numero] = true;
    seguimientos[numero] = { estado: 'cerrado_venta', timestamp: Date.now(), intentos: 0 };
    return res.send('CERRADO VENTA ✅ ' + numero + ' — sin más seguimiento');
  }
  if (cmd === 'cerrado_perdido' && numero) {
    pausados[numero] = true;
    seguimientos[numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: 0 };
    return res.send('CERRADO PERDIDO ✅ ' + numero + ' — sin más seguimiento');
  }
  return res.send('Comando no reconocido.');
});

app.get('/', function(req, res) {
  res.json({ status: 'Agente Lili V10 activo', pausadoTodo: pausadoTodo, pausados: Object.keys(pausados).length, seguimientos: Object.keys(seguimientos).length });
});

app.get('/webhook', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  try {
    var entry = req.body.entry;
    if (!entry) return;
    var value = entry[0].changes[0].value;
    if (!value) return;

    // ── Detectar mensajes SALIENTES de Lili (desde WhatsApp Business) ──
    if (value.statuses) {
      // Son eventos de estado (enviado, leído), no mensajes — ignorar
      return;
    }

    // Mensajes salientes: Meta los envía con contacts pero sin messages cuando son del business
    // Los mensajes que Lili envía manualmente llegan como tipo 'sent' en algunos webhooks
    // Lo detectamos por el campo 'messages' con from === PHONE_NUMBER_ID o por campo específico
    if (value.messages) {
      var message = value.messages[0];
      
      // Detectar si es mensaje saliente (enviado por Lili desde WhatsApp Business)
      // Meta marca los mensajes salientes con un campo diferente según la versión
      var esSaliente = false;
      if (message.from && message.from === PHONE_NUMBER_ID) esSaliente = true;
      // Algunos webhooks usan este campo para mensajes enviados manualmente
      if (value.metadata && value.metadata.phone_number_id && message.from === value.metadata.phone_number_id) esSaliente = true;

      if (esSaliente && message.type === 'text') {
        // Mensaje saliente de Lili — pausa automática + detectar estado para seguimiento
        var leadNumero = message.to || null;
        if (leadNumero) {
          // PAUSA AUTOMÁTICA: Lili tomó el control, agente se hace a un lado
          pausados[leadNumero] = true;
          console.log('Lili escribió a ' + leadNumero + ' — número pausado automáticamente');

          // Guardar mensaje de Lili en historial para que el agente tenga contexto después
          if (!conversaciones[leadNumero]) conversaciones[leadNumero] = [];
          conversaciones[leadNumero].push({ role: 'assistant', content: message.text.body });
          if (conversaciones[leadNumero].length > 12) conversaciones[leadNumero] = conversaciones[leadNumero].slice(-12);
          guardarHistorial();

          // Detectar estado para seguimiento automático
          var estadoDetectado = detectarEstadoPorMensajeLili(message.text.body);
          if (estadoDetectado) {
            activarSeguimiento(leadNumero, estadoDetectado);
            console.log('Estado seguimiento activado para ' + leadNumero + ': ' + estadoDetectado);
          }
        }
        return;
      }

      // Mensaje ENTRANTE del lead
      if (message && message.type === 'text') {
        var from = message.from;
        var texto = message.text.body;
        console.log('Mensaje de ' + from + ': ' + texto);

        // Cancelar seguimiento activo si el lead respondió
        cancelarSeguimiento(from);

        // Detectar si el lead prometió info (para activar seguimiento esperando_info)
        if (leadPrometioInfo(texto) && !pausados[from]) {
          // Se activa después de que el agente responda
          setTimeout(function() {
            if (!pausados[from]) {
              activarSeguimiento(from, 'esperando_info');
            }
          }, 2000);
        }

        if (pausadoTodo) { console.log('Pausado global'); return; }
        if (pausados[from]) { console.log('Numero pausado: ' + from); return; }

        setTimeout(function() { procesarMensaje(from, texto); }, 500);
      }
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

function procesarMensaje(from, texto) {
  if (!conversaciones[from]) conversaciones[from] = [];
  conversaciones[from].push({ role: 'user', content: texto });
  if (conversaciones[from].length > 12) conversaciones[from] = conversaciones[from].slice(-12);
  guardarHistorial();

  axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5',
      max_tokens: 600,
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
  ).then(function(response) {
    var respuesta = response.data.content[0].text;
    console.log('Claude: ' + respuesta);
    conversaciones[from].push({ role: 'assistant', content: respuesta });
    guardarHistorial();

    var necesitaEscalar = respuesta.indexOf('[ESCALAR]') !== -1;
    var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').trim();

    if (necesitaEscalar) {
      notificarLili(from, texto.substring(0, 100));
      pausados[from] = true;
      console.log('Escalado. Numero pausado: ' + from);
    }

    enviarMensaje(from, textoLimpio);

  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    enviarMensaje(from, 'Hola! 🙌 Estoy revisando tu mensaje, en un momento te respondo 😊');
  });
}

function enviarMensaje(to, texto) {
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: texto } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Mensaje enviado a ' + to);
  }).catch(function(error) {
    console.error('Error mensaje:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

app.listen(PORT, function() {
  console.log('Agente Lili V10 en puerto ' + PORT);
});

module.exports = app;
