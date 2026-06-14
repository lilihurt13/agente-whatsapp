const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = 'hecho_por_lili_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONTROL_TOKEN = 'lili2026';
const LILI_NUMERO = '573008654636';
const TELEGRAM_TOKEN = '8868128825:AAEv_STo16YwsORBZepK2_raWfAhMNMTiiU';
const TELEGRAM_CHAT_ID = '2056034612';

// ─── BASE DE DATOS POSTGRESQL ──────────────────────────────────────────────
// Toda la persistencia (conversaciones, pausas, seguimientos) vive aqui, no en
// memoria ni en /tmp. Asi sobrevive a reinicios y deploys de Railway.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Estado en memoria (espejo de la BD para acceso rapido).
// Se carga desde la BD al arrancar y se mantiene sincronizado con cada cambio.
const conversaciones = {};
const pausados = {};
const seguimientos = {};
const notas = {}; // notas personales de Lili por lead (rastro de lo hablado por audio/fuera del sistema)
const ultimaActividad = {}; // timestamp del último mensaje por lead, para ordenar el panel
const procesando = {}; // evita procesar dos mensajes del mismo numero a la vez
let pausadoTodo = false;
let bdLista = false;

// Crear tablas si no existen + cargar todo a memoria
async function inicializarBD() {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS conversaciones (numero TEXT PRIMARY KEY, mensajes JSONB NOT NULL DEFAULT \'[]\')');
    await pool.query('CREATE TABLE IF NOT EXISTS pausados (numero TEXT PRIMARY KEY)');
    await pool.query('CREATE TABLE IF NOT EXISTS seguimientos (numero TEXT PRIMARY KEY, estado TEXT NOT NULL, timestamp BIGINT NOT NULL, intentos INT NOT NULL DEFAULT 0, ultimo_mensaje_lead BIGINT)');
    await pool.query('CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT)');
    await pool.query('CREATE TABLE IF NOT EXISTS notas (numero TEXT PRIMARY KEY, nota TEXT)');

    var rc = await pool.query('SELECT numero, mensajes FROM conversaciones');
    var baseT = Date.now();
    rc.rows.forEach(function(row, idx) {
      conversaciones[row.numero] = row.mensajes || [];
      // Marca base por orden de carga (los más recientes en la BD quedan arriba).
      // Se irá actualizando con cada mensaje nuevo real.
      ultimaActividad[row.numero] = baseT - (rc.rows.length - idx) * 1000;
    });

    var rp = await pool.query('SELECT numero FROM pausados');
    rp.rows.forEach(function(row) { pausados[row.numero] = true; });

    var rs = await pool.query('SELECT numero, estado, timestamp, intentos, ultimo_mensaje_lead FROM seguimientos');
    rs.rows.forEach(function(row) {
      seguimientos[row.numero] = {
        estado: row.estado,
        timestamp: Number(row.timestamp),
        intentos: row.intentos,
        ultimoMensajeLead: row.ultimo_mensaje_lead ? Number(row.ultimo_mensaje_lead) : undefined
      };
    });

    var ra = await pool.query("SELECT valor FROM ajustes WHERE clave = 'pausadoTodo'");
    if (ra.rows.length > 0) pausadoTodo = ra.rows[0].valor === 'true';

    var rn = await pool.query('SELECT numero, nota FROM notas');
    rn.rows.forEach(function(row) { if (row.nota) notas[row.numero] = row.nota; });

    bdLista = true;
    console.log('BD lista: ' + rc.rows.length + ' conversaciones, ' + rp.rows.length + ' pausados, ' + rs.rows.length + ' seguimientos');
  } catch (e) {
    console.error('Error inicializando BD:', e.message);
  }
}

// ─── FUNCIONES DE PERSISTENCIA (memoria + BD) ──────────────────────────────
function guardarConversacion(numero) {
  ultimaActividad[numero] = Date.now();
  var msgs = conversaciones[numero] || [];
  pool.query(
    'INSERT INTO conversaciones (numero, mensajes) VALUES ($1, $2) ON CONFLICT (numero) DO UPDATE SET mensajes = $2',
    [numero, JSON.stringify(msgs)]
  ).catch(function(e) { console.error('Error guardando conversacion ' + numero + ':', e.message); });
}

function marcarPausado(numero) {
  pausados[numero] = true;
  pool.query('INSERT INTO pausados (numero) VALUES ($1) ON CONFLICT (numero) DO NOTHING', [numero])
    .catch(function(e) { console.error('Error pausando ' + numero + ':', e.message); });
}

function quitarPausado(numero) {
  delete pausados[numero];
  pool.query('DELETE FROM pausados WHERE numero = $1', [numero])
    .catch(function(e) { console.error('Error despausando ' + numero + ':', e.message); });
}

function quitarTodosPausados() {
  Object.keys(pausados).forEach(function(n) { delete pausados[n]; });
  pool.query('DELETE FROM pausados')
    .catch(function(e) { console.error('Error limpiando pausados:', e.message); });
}

function guardarSeguimiento(numero) {
  var s = seguimientos[numero];
  if (!s) return;
  pool.query(
    'INSERT INTO seguimientos (numero, estado, timestamp, intentos, ultimo_mensaje_lead) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (numero) DO UPDATE SET estado = $2, timestamp = $3, intentos = $4, ultimo_mensaje_lead = $5',
    [numero, s.estado, s.timestamp, s.intentos, s.ultimoMensajeLead || null]
  ).catch(function(e) { console.error('Error guardando seguimiento ' + numero + ':', e.message); });
}

function borrarSeguimiento(numero) {
  delete seguimientos[numero];
  pool.query('DELETE FROM seguimientos WHERE numero = $1', [numero])
    .catch(function(e) { console.error('Error borrando seguimiento ' + numero + ':', e.message); });
}

function guardarPausadoTodo() {
  pool.query(
    "INSERT INTO ajustes (clave, valor) VALUES ('pausadoTodo', $1) ON CONFLICT (clave) DO UPDATE SET valor = $1",
    [pausadoTodo ? 'true' : 'false']
  ).catch(function(e) { console.error('Error guardando pausadoTodo:', e.message); });
}

function guardarNota(numero) {
  var nota = notas[numero] || '';
  pool.query(
    'INSERT INTO notas (numero, nota) VALUES ($1, $2) ON CONFLICT (numero) DO UPDATE SET nota = $2',
    [numero, nota]
  ).catch(function(e) { console.error('Error guardando nota ' + numero + ':', e.message); });
}
// ─── FIN PERSISTENCIA ──────────────────────────────────────────────────────

// ─── SISTEMA DE SEGUIMIENTO ────────────────────────────────────────────────
const KEYWORDS_COTIZACION = ['cotización', 'cotizacion', 'propuesta', 'el valor quedaría', 'el valor quedaria', 'te paso el precio', 'precio quedaría', 'precio quedaria', 'presupuesto', 'valor total', 'anticipo'];
const KEYWORDS_DECISION = ['te mando fotos', 'te envío fotos', 'te envio fotos', 'mira estas fotos', 'aquí unas referencias', 'aqui unas referencias', 'referencia', 'referencias', 'estas opciones', 'qué estilo', 'que estilo', 'cuál te gusta', 'cual te gusta'];
const KEYWORDS_LEAD_PROMETE = ['mañana', 'manana', 'luego te', 'te paso', 'te envío', 'te envio', 'te mando', 'después', 'despues', 'más tarde', 'mas tarde', 'esta semana', 'hoy te'];

const TIEMPO = {
  saludo_1:              24 * 60 * 60 * 1000,
  saludo_2:              48 * 60 * 60 * 1000,
  esperando_info_1:      48 * 60 * 60 * 1000,
  esperando_info_2:      48 * 60 * 60 * 1000,
  esperando_decision_1:  24 * 60 * 60 * 1000,
  esperando_decision_2:  24 * 60 * 60 * 1000,
  cotizacion_1:           4 * 24 * 60 * 60 * 1000,
  cotizacion_2:           7 * 24 * 60 * 60 * 1000,
};

function getMensajeSeguimiento(estado, intento, nombre) {
  var n = nombre ? nombre : '';
  var saludo = n ? ('Hola ' + n + '! 😊') : 'Hola! 😊';

  if (estado === 'saludo_sin_respuesta') {
    if (intento === 1) return saludo + ' ¿Pudiste pensar en la repisa? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿';
    if (intento === 2) return saludo + ' Aquí estoy cuando quieras retomar 🌿';
  }
  if (estado === 'esperando_info') {
    if (intento === 1) return saludo + ' Solo quería saber si pudiste tomar las medidas del espacio. Cuando las tengas me avisas y te preparo todo 🌿';
    if (intento === 2) return saludo + ' Aquí estoy cuando quieras retomar 🌿';
  }
  if (estado === 'esperando_decision') {
    if (intento === 1) return saludo + ' ¿Alcanzaste a ver el espacio donde la quieres? Tengo cupo de fabricación esta semana si quieres que te la deje lista 🌿';
    if (intento === 2) return saludo + ' Solo para no dejarte la repisa pendiente — si más adelante la quieres retomar, aquí estoy con mucho gusto 😊';
  }
  if (estado === 'cotizacion_enviada') {
    if (intento === 1) return saludo + ' ¿Cómo te fue con la cotización de tu repisa? Si quieres ajustamos cualquier detalle (medida, fecha de entrega). Tengo cupo para arrancar esta semana 🌿';
    if (intento === 2) return saludo + ' Solo para no dejarte la repisa pendiente — si más adelante la quieres retomar, aquí estoy con mucho gusto 😊';
  }
  return null;
}

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

function leadPrometioInfo(texto) {
  var textoLower = texto.toLowerCase();
  for (var i = 0; i < KEYWORDS_LEAD_PROMETE.length; i++) {
    if (textoLower.indexOf(KEYWORDS_LEAD_PROMETE[i]) !== -1) return true;
  }
  return false;
}

function activarSeguimiento(numero, estado) {
  if (seguimientos[numero] &&
      (seguimientos[numero].estado === 'cerrado_venta' ||
       seguimientos[numero].estado === 'cerrado_perdido')) return;

  seguimientos[numero] = { estado: estado, timestamp: Date.now(), intentos: 0 };
  guardarSeguimiento(numero);
  console.log('Seguimiento activado para ' + numero + ': ' + estado);
}

function cancelarSeguimiento(numero) {
  if (seguimientos[numero] &&
      seguimientos[numero].estado !== 'cerrado_venta' &&
      seguimientos[numero].estado !== 'cerrado_perdido') {
    borrarSeguimiento(numero);
    console.log('Seguimiento cancelado para ' + numero + ' (respondió)');
  }
}

function getNombreLead(numero) {
  if (!conversaciones[numero]) return null;
  return null;
}

// CRON: revisar seguimientos cada hora
setInterval(function() {
  if (!bdLista) return;
  var ahora = Date.now();
  var numeros = Object.keys(seguimientos);

  for (var i = 0; i < numeros.length; i++) {
    var numero = numeros[i];
    var seg = seguimientos[numero];

    if (seg.estado === 'cerrado_venta' || seg.estado === 'cerrado_perdido') continue;
    if (seg.estado === 'saludo_sin_respuesta') continue;
    if (pausadoTodo) continue;
    // IMPORTANTE: NO bloqueamos por pausados[numero] aquí.
    // Los seguimientos de cotización/fotos/info deben dispararse incluso si el lead está pausado
    // (Lili lo pausó para atenderlo, pero el seguimiento automático de Olivia sigue corriendo).
    // El cron quita la pausa antes de enviar el mensaje (línea quitarPausado abajo).

    var transcurrido = ahora - seg.timestamp;
    var tiempoEspera = null;

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
        var nombre = getNombreLead(numero);
        var mensaje = getMensajeSeguimiento(seg.estado, seg.intentos, nombre);

        if (mensaje) {
          quitarPausado(numero);
          enviarMensaje(numero, mensaje);
          seg.timestamp = Date.now();
          guardarSeguimiento(numero);
          console.log('Seguimiento enviado a ' + numero + ' (intento ' + seg.intentos + ', estado: ' + seg.estado + ')');
        }
      } else {
        seguimientos[numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: seg.intentos };
        guardarSeguimiento(numero);
        console.log('Lead cerrado silenciosamente (sin respuesta): ' + numero);
      }
    }
  }
}, 60 * 60 * 1000);

// ─── TANDAS DIARIAS DE REACTIVACIÓN (12PM Y 7PM HORA COLOMBIA) ─────────────
var ultimaTandaReactivacion = null;

function mensajeReactivacion(intento) {
  if (intento === 1) return 'Hola! 😊 ¿Pudiste pensar en la repisa? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿';
  return 'Hola! 😊 No hay afán. Si en algún momento quieres retomar, aquí estoy con gusto 🌿';
}

setInterval(function() {
  if (!bdLista) return;
  var ahoraUTC = new Date();
  var horaColombia = (ahoraUTC.getUTCHours() - 5 + 24) % 24;
  var fechaColombia = new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (horaColombia !== 12 && horaColombia !== 19) return;
  var marca = fechaColombia + '-' + horaColombia;
  if (ultimaTandaReactivacion === marca) return;
  ultimaTandaReactivacion = marca;

  if (pausadoTodo) { console.log('Tanda reactivación: pausado global, no se envía'); return; }

  var candidatos = [];
  var numeros = Object.keys(seguimientos);
  for (var i = 0; i < numeros.length; i++) {
    var numero = numeros[i];
    var seg = seguimientos[numero];
    if (seg.estado !== 'saludo_sin_respuesta') continue;
    if (pausados[numero]) continue;

    var ahora = Date.now();
    var ref = seg.ultimoMensajeLead || seg.timestamp;
    var horasDesde = (ahora - ref) / (60 * 60 * 1000);

    if (horasDesde >= 3 && horasDesde <= 24) {
      candidatos.push({ numero: numero, seg: seg });
    } else if (horasDesde > 24) {
      seguimientos[numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: seg.intentos };
      guardarSeguimiento(numero);
      console.log('Lead fuera de ventana 24h, cerrado: ' + numero);
    }
  }

  console.log('Tanda reactivación (' + horaColombia + 'h): ' + candidatos.length + ' leads para reactivar');

  candidatos.forEach(function(c, idx) {
    setTimeout(function() {
      if (pausados[c.numero]) return;
      c.seg.intentos++;
      if (c.seg.intentos <= 2) {
        enviarMensaje(c.numero, mensajeReactivacion(c.seg.intentos));
        c.seg.timestamp = Date.now();
        guardarSeguimiento(c.numero);
        console.log('Reactivación enviada a ' + c.numero + ' (intento ' + c.seg.intentos + ')');
      } else {
        seguimientos[c.numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: c.seg.intentos };
        guardarSeguimiento(c.numero);
        console.log('Lead cerrado tras 2 reactivaciones: ' + c.numero);
      }
    }, idx * 5000);
  });

}, 60 * 60 * 1000);
// ─── FIN SISTEMA DE SEGUIMIENTO ───────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Olivia, parte del equipo de Hecho por Lili, una marca de muebles artesanales en roble natural en Medellin, Colombia, fundada por la diseñadora Lili Hurtado. Acompañas a los clientes en WhatsApp: les das información, los asesoras sobre los muebles y los espacios, y cuando hace falta atención personal o algo se sale de lo que sabes, pasas la conversación a Lili.

QUIÉN ERES:
- Eres Olivia, una asistente cálida y cercana del equipo de Hecho por Lili. NO eres Lili — Lili es la fundadora y diseñadora. Tú eres parte de su equipo y la ayudas atendiendo a los clientes.
- Cuando un cliente necesita hablar directamente con Lili o con una persona del equipo, con gusto los conectas (escalas).
- Si un cliente te pregunta si eres una persona o un asistente, respondes con naturalidad y calidez: que eres Olivia, del equipo de Hecho por Lili, y que con gusto le ayudas — sin hacer drama del tema. Si quiere hablar con alguien del equipo personalmente, lo conectas.

PERSONALIDAD Y TONO:
- Cálida y cercana, pero siempre profesional — eres una asesora experta que trata muy bien a los clientes
- Usas emojis naturalmente pero con mesura
- Llamas clientes por nombre cuando lo sabes
- Eres consultora de espacios, no solo vendedora
- Respuestas cortas, max 5-6 lineas, natural como WhatsApp
- NUNCA uses asteriscos para negrillas — ni para títulos, ni para nombres de productos, ni en listas de catálogo. El texto siempre va limpio, sin asteriscos en ningún caso.
- NUNCA des la lista completa de precios ni el catálogo completo, aunque el lead lo pida directamente ("pásame el catálogo", "todos los precios", "qué tienen y cuánto vale"). En vez de eso, pregunta qué producto o qué espacio le interesa y guía la conversación hacia UN producto a la vez. Solo das el precio de lo que el lead específicamente pregunta.
- NUNCA menciones estilos como rustico, moderno, escandinavo
- Tu linea: roble natural macizo, lineas limpias, bordes suaves, hecho a mano
- NUNCA uses frases como "lamentablemente", "no tenemos", "no manejamos", "no contamos con"
- SIEMPRE responde en positivo, todo se puede hacer o cotizar
- SOLO usa expresiones colombianas naturales. NUNCA uses modismos mexicanos ni de otros países. Ejemplos prohibidos: "te late", "órale", "chido", "wey", "padrísimo", "ahorita" (en sentido mexicano), "mande". En Colombia se dice: "listo", "con gusto", "claro que sí", "dale", "qué bueno"
- NUNCA uses "bacano" ni expresiones demasiado informales — el tono es cálido pero elegante
- NUNCA menciones elección de color — todas las piezas son en roble natural, no hay opciones de color
- ENVÍO DE REPISAS A OTRAS CIUDADES: SÍ se envía a otras ciudades. NO hay instalación fuera de Medellín, pero la repisa es flotante y va con sus soportes para que el cliente la instale. NUNCA digas que vas a revisar si consigues instalador — no hay instaladores fuera de Medellín. Valores de envío más abajo en la sección de repisas.

SALUDO INICIAL (SOLO primer mensaje de cada persona nueva):
Primero se envían automáticamente DOS fotos del producto (esto lo hace el sistema, no lo escribas en el mensaje).
Luego envías este texto EXACTO:

"¡Hola! 👋 Soy Olivia, del equipo de Hecho por Lili 🌿

Hacemos repisas flotantes en roble natural — herrajes invisibles, esquinas redondeadas, bordes suaves e instalación incluida en Medellín. La de 60cm queda en $220.000.

¿Esta medida te funciona o necesitas otra? Cuéntame el espacio y te doy el valor exacto 😊"

REGLA CRÍTICA — CONTINUIDAD DE CONVERSACIÓN:
Si ya hay mensajes previos en el historial con este número, NUNCA vuelvas a saludar como si fuera la primera vez. NUNCA digas "Hola, soy Olivia..." de nuevo.
Lee el historial, entiende en qué punto iba la conversación y continúa naturalmente desde ahí.
Ejemplos:
- Si iban hablando de una repisa de 120cm y el lead vuelve → continúa con esa conversación directamente
- Si el lead dice "ok, me decido por la de 80cm" → responde en contexto, no saludes de nuevo
- Si el lead dice "feliz día" o "hola" después de una conversación previa → responde cálido pero SIN presentarte de nuevo
El saludo inicial con presentación completa es SOLO para personas que escriben por primera vez.
Si alguien te escribe algo que NO tiene que ver con comprar o preguntar por muebles (por ejemplo: confirmar entregas, hablar de citas previas, mencionar trabajos en proceso, referencias a conversaciones anteriores que no conoces), responde SIEMPRE asi:
"Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"
Esto escala a Lili inmediatamente para que ella responda.

REGLA CRÍTICA — CUANDO NO SABES LA RESPUESTA:
Si alguien pregunta algo que no está en el catálogo ni en las reglas (dónde están ubicados, si tienen tienda, si pueden visitar, horarios, redes sociales, referencias de clientes, etc.), SIEMPRE escala:
"Permíteme un momento que te confirmo ese detalle 😊 [ESCALAR]"
NUNCA inventes información.
NUNCA digas que pueden venir a ver piezas o visitar el taller — no hay tienda ni showroom abierto al público. El trabajo es 100% personalizado y por encargo. Las fotos de los proyectos se envían por WhatsApp.

DETECTAR CONTEXTO ROTO — CONVERSACIÓN INTERMEDIA:
Si hay historial previo Y el último mensaje del agente fue [ESCALAR] o hablar de cotización/precio personalizado/fotos, Y la respuesta del lead NO tiene coherencia directa con lo que el agente preguntó, significa que hubo una conversación intermedia que el agente no vio.
En ese caso SIEMPRE escalar con:
"¡Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"
NUNCA intentes responder inventando contexto que no tienes.
Ejemplos de contexto roto:
- Agente escaló por cotización → lead responde "sí, de acuerdo", "gracias", "cuándo me lo entregan" → ESCALAR
- Agente preguntó medida → lead responde "ok perfecto" o "listo" sin dar medida → ESCALAR
- Lead responde algo que asume información que el agente nunca dio → ESCALAR

REGLA MAESTRA DE INSTALACIÓN Y ENVÍO (CRÍTICA — APLICA A TODOS LOS PRODUCTOS):
- La instalación SOLO se hace en Medellín, donde está incluida gratis. En NINGUNA otra ciudad se ofrece instalación.
- Si un lead de OTRA ciudad pregunta por instalación o por instaladores, responde con claridad que la instalación solo está incluida en Medellín y que a otras ciudades únicamente se hace envío. NUNCA digas "déjame revisar si tengo instaladores", NUNCA des a entender que se les puede conseguir un instalador. Eso no existe.
- NUNCA inventes datos: ni precios, ni medidas, ni costos de envío, ni instaladores, ni plazos. Lo que no esté explícito aquí, se escala.
- Qué requiere instalación y qué no (por mueble):
  • Repisas → requieren instalación. Medellín: incluida. Otras ciudades: solo envío (con costo), sin instalación.
  • Escritorio flotante → requiere instalación. Medellín: se instala. Otras ciudades: no se instala.
  • Escritorio con cajones (con base) → NO requiere instalación, se entrega listo y se ubica en el lugar. Solo Medellín.
  • Recibidor → NO requiere instalación, se lleva y se ubica.
  • Mesa auxiliar → NO requiere instalación, se entrega lista (en otras ciudades puede enviarse desarmada y la arma el cliente con unos tornillos).
  • Mesa de centro con jardinera → NO requiere instalación. Solo Medellín.
  • Cama → requiere instalación (la instala Lili). Solo Medellín, sin envío a otras ciudades.

CATALOGO COMPLETO:

⛔ REGLA MAESTRA DE PRECIOS (LA MÁS IMPORTANTE — NUNCA LA ROMPAS):
- SOLO puedes dar los precios EXACTOS que están escritos en este catálogo, y SOLO para la medida estándar exacta de cada mueble (o las 6 medidas exactas de repisas).
- Si el cliente pide CUALQUIER medida distinta a la estándar (más grande, más pequeña, personalizada), NUNCA calcules, estimes, "proporciones" ni inventes un precio. El precio de una medida personalizada NO lo sabes — solo Lili lo sabe.
- En medidas personalizadas SIEMPRE escalas con algo como: "Esa medida la hacemos con gusto 😊 Ya te confirmo el valor exacto y te lo paso. [ESCALAR]"
- Ejemplo de error GRAVE que NUNCA debes cometer: el escritorio flotante de 75cm vale $1.590.000; si piden uno de 100cm, NO digas "$1.890.000" ni ningún número — ESCALA. El precio del de 100cm NO está en tu información.
- Es mil veces mejor escalar y que Lili dé el precio, que inventar un número equivocado. Inventar un precio es el peor error que puedes cometer.


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
- Envio: Solo Medellin
- Instalacion: No requiere, se entrega listo y se ubica en el lugar
- Medidas personalizadas: siempre disponibles, escalar para precio

3. REPISAS FLOTANTES
- Las repisas se pueden fabricar en cualquier largo, pero SOLO tienes precio confirmado para estas medidas exactas (profundidad 15cm, espesor 3.6cm):

  50cm  → $200.000 (2 soportes)
  60cm  → $220.000 (2 soportes) ← precio gancho del anuncio
  70cm  → $240.000 (2 soportes)
  80cm  → $260.000 (2 soportes)
  90cm  → $300.000 (2 soportes)
  100cm → $320.000 (2 soportes)
  110cm → $340.000 (3 soportes)
  120cm → $350.000 (3 soportes)
  130cm → $370.000 (3 soportes)
  140cm → $380.000 (3 soportes)
  160cm → $420.000 (4 soportes)
  180cm → $440.000 (4 soportes)
  200cm → $460.000 (4 soportes)

CUÁNDO OLIVIA CIERRA SOLA (sin escalar):
- La medida está en la tabla de 13 medidas de arriba (15cm de profundidad, 3.6cm espesor).
- Es para Medellín (instalación incluida) O es envío a ciudad principal con valor de tabla.
- No hay ninguna complicación (no piden 30cm de profundidad, no es pared en L, no es cajón, no es módulo).
En estos casos Olivia cierra sola: da precio → confirma medida → explica pago (60/40 transferencia Bancolombia) → escala para que Lili reciba el anticipo.

CUÁNDO ESCALA SIEMPRE (aunque la medida sea conocida):
- Piden profundidad diferente a 15cm (30cm, 25cm, 40cm, etc.)
- Pared en L, cajón integrado, módulo cerrado, tapa superior.
- Envío a ciudad NO principal (Ipiales, Pasto, o cualquier ciudad no listada en la tabla de envíos).
- Repisas de 180 o 200cm con envío (escalar para confirmar costo de envío con Lili).
- Combos con descuento (Olivia puede mencionarlos pero confirma con Lili antes de cerrar).
- Cualquier duda sobre material, sistema de instalación en muro especial.

- REGLA DURA: NUNCA calcules ni inventes precios fuera de esta tabla. Si la medida o el caso no aparece, escala: "Esa medida la fabricamos con gusto 😊 Permíteme un momento que te confirmo el valor exacto. [ESCALAR]"
- Instalacion: Incluida en Medellin
- Envio otras ciudades: SÍ se envía. Va empacada con sus soportes (el cliente la instala). NO hay instalación fuera de Medellín.
- VALORES DE ENVÍO ciudades principales (Bogotá, Cali, Barranquilla, Pereira, Valledupar, Bucaramanga, Cartagena, Manizales, Armenia, Ibagué):
  60cm a 100cm → $35.000
  120cm a 160cm → $45.000
  180cm a 200cm → ESCALA (confirmar con Lili)
- Ciudades NO principales (Ipiales, Pasto, otras no listadas): ESCALA para confirmar envío.
- Zonas difícil acceso (San Andrés, Leticia, Quibdó, Mitú, etc.): ESCALA siempre.
- Tiempo: 5-6 dias habiles
- Caracteristicas siempre mencionar: 15cm profundidad, 3.6cm espesor, herrajes invisibles, esquinas redondeadas, bordes suaves, barniz protector

REGLA GLOBAL REPISAS — NUNCA menciones el uso específico (TV, baño, sala, cocina, etc.) en ningún mensaje. Habla siempre de la repisa de forma genérica. Si el lead lo menciona, ignóralo y sigue el flujo normal sin referenciarlo.
Las repisas son compra de impulso. El precio ya viene filtrado desde el anuncio.
- REGLA DE ORO DEL PRECIO (APLICA A TODO, INCLUSO REPISAS): el precio SIEMPRE va al FINAL del mensaje, NUNCA en la primera línea. Primero las características y el valor del producto (roble macizo, herrajes invisibles, esquinas redondeadas, profundidad, etc.), y al final, después de todo eso, el precio. NUNCA arranques un mensaje con "La repisa vale $X" o "Queda en $X". El precio cierra el mensaje, no lo abre.

FLUJO OBLIGATORIO PARA REPISAS — SIGUE ESTE ORDEN SIEMPRE:

PASO 1 — Saludo + ancla en 60cm + pregunta medida:
Cuando llegue cualquier lead de repisa (sin importar cómo pregunte), el sistema envía automáticamente DOS fotos del producto, y luego tú respondes SIEMPRE con este mensaje EXACTO:

"¡Hola! 👋 Soy Olivia, del equipo de Hecho por Lili 🌿

Hacemos repisas flotantes en roble natural — herrajes invisibles, esquinas redondeadas, bordes suaves e instalación incluida en Medellín. La de 60cm queda en $220.000.

¿Esta medida te funciona o necesitas otra? Cuéntame el espacio y te doy el valor exacto 😊"

NUNCA menciones el uso específico (TV, baño, sala, etc.) en este primer mensaje.
NUNCA listes otras medidas en este primer mensaje.
NUNCA alargues este mensaje con más información.

PASO 2 — Lead confirma la de 60cm → pre-cierre:
Si el lead dice que sí le sirve la de 60cm, responde:
"Perfecto 😊 Tu repisa de 60cm en roble macizo, lista en 5-6 días con instalación incluida en Medellín. ¿Arrancamos?"
NO pidas dirección ni datos de pago todavía.

PASO 2B — Lead dice sí a arrancar → dar método de pago + datos + escalar a Lili:
"Perfecto 🌿 El pago es por transferencia bancaria — el 60% de anticipo inicia la producción y el 40% restante lo pagas al momento de la entrega (o antes del envío si es otra ciudad).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

Cuando hagas el anticipo me avisas y arrancamos de una 😊 [ESCALAR]"

PASO 2C — Lead pide otra medida ESTÁNDAR → da precio + pre-cierre:
Las 13 medidas CON precio son: 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 160, 180, 200cm. Para CUALQUIERA de estas das el precio directo, sin escalar.
Ejemplo Medellín (100cm): "Perfecto 😊 La de 100cm es en roble macizo, 15cm de profundidad, 3.6cm de espesor, herrajes invisibles, esquinas redondeadas y bordes suaves. Lista en 5-6 días con instalación incluida en Medellín. Queda en $320.000. ¿Arrancamos con esa?"
Ejemplo OTRA CIUDAD (Bogotá, 160cm): "Perfecto 😊 La de 160cm es en roble macizo, 15cm de profundidad, 3.6cm de espesor, herrajes invisibles, esquinas redondeadas y bordes suaves. Va con sus soportes para que la instales tú. Queda en $420.000 más $45.000 de envío. ¿Arrancamos? 🌿"
ENVÍOS: 60-100cm = $35.000 | 120-160cm = $45.000 | 180-200cm = ESCALA
Si la medida NO está en la lista de 10 (ej: 70, 110, 130cm) → escala: "Esa medida la fabricamos con gusto 😊 Permíteme un momento que te confirmo el valor exacto. [ESCALAR]"

PASO 3 — Lead dice sí a arrancar con otra medida → dar método de pago + datos + escalar:
"Perfecto 🌿 El pago es por transferencia bancaria — el 60% de anticipo inicia la producción y el 40% restante lo pagas al momento de la entrega (o antes del envío si es otra ciudad).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

Cuando hagas el anticipo me avisas y arrancamos de una 😊 [ESCALAR]"

PASO 4 — Si lead confirma → escalar a Lili para proceso de pago
PASO 5 — Si piden medida que no está en las 10 → escalar para precio
PASO 6 — Si lead pregunta de otra ciudad NO principal → escalar

SEÑALES DE COMPRA — cuando el lead manda estas señales, Olivia avanza al cierre, no solo informa:

"¿La pueden hacer más oscura?" / pregunta por color:
"¡Claro que sí! 😊 La podemos dejar en el tono que quieras, queda preciosa. ¿Para qué medida la estás pensando? Así te dejo todo listo y arrancamos 😊"

"¿Qué medidas manejan?" / "¿cuánto mide esa?":
"Manejamos varias medidas 😊 Cuéntame el largo del espacio donde la quieres y te digo la medida ideal con su valor."

"¿Cómo es el modo de pago?" (señal fuerte — ya casi compra):
"¡Perfecto! 😊 Para arrancar con tu repisa es muy fácil: el 60% de anticipo inicia la fabricación, y el 40% lo pagas al momento de la entrega (o antes del envío si es fuera de Medellín).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

¿Arrancamos? 😊"
(En este caso NO escalar todavía — solo escalar si dice que sí quiere arrancar)

MANEJO DE OBJECIONES:

"Voy a consultar con mi esposo/pareja" / "déjame pensarlo":
"¡Claro que sí! 😊 Cuéntame una cosa: ¿hay algo puntual que quieran revisar — la medida, el espacio donde va? Así te paso cualquier detalle que necesiten para decidir tranquilos. Te cuento que ahorita tengo cupo para fabricar esta semana; si me confirmas en estos días te la alcanzo a dejar sin lista de espera 😊"

"¿Cómo se instala?" (fuera de Medellín):
"Es muy sencillo 😊 Va con soportes invisibles que se anclan a la pared, la repisa queda totalmente flotante. Si quieres te mando la foto de cómo van los soportes para que lo veas."

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
7. EL PRECIO SIEMPRE AL FINAL DEL MENSAJE: cuando llegue el momento de dar un precio, primero van las características y beneficios del mueble, y el precio se menciona al FINAL, en la última parte del mensaje. NUNCA empieces un mensaje con el precio. Esto aplica a TODOS los productos, incluidas las repisas.
   - ACLARACIÓN REPISAS: "precio al final" NO significa alargar la conversación ni hacer más preguntas. Las repisas son compra de impulso. Solo significa el ORDEN dentro del mismo mensaje: características primero, precio de cierre. Ejemplo correcto para una medida estándar: "La de 120cm es en roble macizo, 15x3.6cm, herrajes invisibles, esquinas redondeadas, instalación incluida en Medellín. Queda en $350.000. ¿Arrancamos?" — todo en UN mensaje, sin preguntas extra.
   - ACLARACIÓN OTROS MUEBLES (escritorio, cama, recibidor, mesas): aquí SÍ va primero el enganche (preguntar dónde va, para qué espacio, si las medidas estándar le sirven) para generar interés, y el precio se da después de 1-2 intercambios, siempre con las características antes y el precio al final.

MÉTODO DE PAGO — DOS CASOS DISTINTOS:

CASO 1 — El lead SOLO PREGUNTA cómo se paga (sin haber dicho que quiere comprar todavía):
Responde sola, sin escalar:
"El pago es por transferencia bancaria 😊 Se arranca con un anticipo del 60% para iniciar la producción, y el 40% restante lo pagas al momento de la entrega (o antes del envío si es otra ciudad). ¿Alguna otra duda? 🌿"
NO escales en este caso — es solo una pregunta informativa.

CASO 2 — El lead ya confirmó que QUIERE COMPRAR/ARRANCAR (dice "sí, me la llevo", "¿cómo arrancamos?", "quiero hacer el pedido", etc.):
Responde el método de pago con los datos Y escala de inmediato:
"Perfecto 🌿 El pago es por transferencia bancaria — el 60% de anticipo inicia la producción y el 40% restante al momento de la entrega (o antes del envío si es otra ciudad).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

Cuando hagas el anticipo me avisas y arrancamos de una 😊 [ESCALAR]"

SIEMPRE:
- NUNCA menciones contraentrega, tarjetas, links de pago ni ningún otro método — solo transferencia bancaria.
- Si el lead insiste en otro método: "Déjame confirmarte esa opción 😊 [ESCALAR]"

DETECCIÓN DE PRODUCTO EN CUALQUIER MENSAJE:
Si en CUALQUIER momento de la conversación el lead menciona "repisa", "repisas", "estante", "estantes", "shelf", activa INMEDIATAMENTE el flujo de repisas — sin importar en qué punto va la conversación, sin importar si ya diste el saludo genérico.
NO sigas con preguntas genéricas como "¿buscas algo específico?" si ya mencionó repisa.
Ve directamente al PASO 1 del flujo de repisas.
Si el lead menciona una medida estándar Y un precio específico (ej: "me interesa la de 100cm ($320.000)"), significa que ya leyó la landing y ya eligió.
NO preguntes para qué es ni dónde va. Asume que ya decidió.
Responde validando su elección + diferenciadores clave + UNA sola pregunta de cierre: "¿Confirmamos esa medida y arrancamos?"

FLUJO ESPECIAL PARA REPISAS — LEAD PIDE AYUDA PARA ELEGIR MEDIDA:
Si el lead dice que no sabe qué medida necesita o pide ayuda para elegir:
Paso 1: Pregunta UNA sola cosa — el ancho disponible en la pared
Paso 2: Cuando responda el ancho → recomienda la medida correspondiente Y pregunta en qué espacio va (sala, dormitorio, baño, etc.)
Paso 3: Cuando diga dónde va → conecta emocionalmente con ese espacio específico y da el precio con contexto
Ejemplo paso 3: "Una repisa de 80cm en tu sala se ve increíble — libera la pared y le da ese toque cálido que transforma el espacio. La hacemos en roble macizo con herrajes invisibles y esquinas redondeadas, lista en 5-6 días con instalación incluida. Queda en $260.000 😊"

PARA REPISAS MEDIDA NO ESTANDAR (solo medidas que NO están en la lista de 13 precios):
RECUERDA: las medidas CON precio son 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 160, 180 y 200cm. Para esas das el precio directo, NUNCA escalas. Solo escalas para medidas que NO están en esa lista (ej: 150, 170cm, o más de 200cm).
Ejemplo para una medida sin precio, como 130cm:
"Perfecto! Las repisas las hacemos en el largo que necesites 😊
La tuya sería de 130 x 15 x 3.6 cm, en roble macizo, con herrajes invisibles, esquinas redondeadas y bordes suaves.
Permíteme un momento y te paso el valor exacto. [ESCALAR]"

PARA LA CAMA:
- Primer mensaje: presentar ambas opciones SIN precio
- Preguntar tamano y si quiere ver fotos
- Si pide fotos: "Claro! En el transcurso del dia te mando las fotos 😊 [ESCALAR]"
- Dar precio solo despues de confirmar tamano Queen

CUANDO ESCALAR (respuestas naturales y cálidas. Como Olivia es del equipo, SÍ puede referirse a Lili con naturalidad, ej: "ya le aviso a Lili"):
- CLIENTE PIDE HABLAR CON UNA PERSONA O ASESOR: Si el cliente dice cosas como "quiero hablar con un asesor", "quiero hablar con una persona", "con un humano", "con alguien real", "con Lili", "me pueden llamar", "necesito hablar con alguien", o muestra frustración con tus respuestas, escala de inmediato con calidez: "¡Claro! Ya le aviso a Lili para que te atienda personalmente 😊 En un momentico te escribe. [ESCALAR]"
- Fotos de la REPISA (cómo es, cómo queda, cómo se ve): el sistema las envía automáticamente. Responde: "¡Claro! Aquí te muestro cómo queda 😊 [FOTOS_EXTRA]" — el sistema enviará las fotos adicionales automáticamente.
- Fotos de REFERENCIA o ESTILO (para elegir diseño, estilo, color): "Claro! En el transcurso del día te paso algunas opciones de referencia para que elijas el estilo 😊 [ESCALAR]"
- Medidas no estandar: "Perfecto! Ya reviso las medidas y en cuanto tenga el valor te lo paso 😊 [ESCALAR]"
- Diseno personalizado: "Claro! En el transcurso del dia te paso opciones de referencia 😊 [ESCALAR]"
- Envio cama o mesa: "Para ese detalle de envio lo reviso bien y te confirmo en cuanto pueda 😊 [ESCALAR]"
- Tamanos no estandar cama: "Claro! Ya reviso las medidas y te preparo la cotizacion 😊 [ESCALAR]"
- Contexto desconocido: "Hola! 😊 Permíteme un momento que te confirmo todo. [ESCALAR]"
- Otra ciudad — DEPENDE DEL PRODUCTO:
  • REPISAS: SÍ se envía con los valores ya indicados ($35.000 para 60-100cm, $45.000 para 120-160cm). Responde el valor de envío directamente, sin escalar, salvo zonas de difícil acceso (San Andrés, Leticia, Quibdó, etc.) que sí se escalan. Recuerda: fuera de Medellín no hay instalación, el cliente la instala (es flotante con soportes).
  • ESCRITORIO FLOTANTE: se envía a todo Colombia, pero fuera de Medellín no se instala. Si preguntan, dilo claro.
  • MESA AUXILIAR: se envía a todo Colombia (puede ir desarmada, el cliente la arma).
  • ESCRITORIO CON CAJONES, MESA DE CENTRO, CAMA: solo Medellín. Si son de otra ciudad: "Ese mueble por ahora lo manejamos en Medellín. Permíteme confirmarte si hay alguna opción para tu ciudad 😊 [ESCALAR]"

IMPORTANTE: [ESCALAR] es interno, el sistema lo elimina del mensaje al cliente y notifica a Lili.

TIEMPO: NUNCA digas "en un momento" para cotizaciones — puede tomar horas o dias.`;

function notificarLili(from, motivo) {
  var mensaje = '🔔 LEAD NECESITA TU ATENCION\n\nNumero: ' + from + '\nSolicitud: ' + motivo + '\n\nRevisa la conversacion y responde cuando puedas 👍';

  axios.post(
    'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
    { chat_id: TELEGRAM_CHAT_ID, text: mensaje }
  ).then(function() {
    console.log('Notificacion Telegram enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando Telegram:', error.response ? JSON.stringify(error.response.data) : error.message);
  });

  axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: LILI_NUMERO, type: 'text', text: { body: mensaje } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Notificacion WhatsApp enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando WhatsApp:', error.message);
  });
}

app.get('/control', function(req, res) {
  var token = req.query.token;
  var cmd = req.query.cmd;
  var numero = req.query.numero;
  if (token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');
  if (numero) numero = numero.replace(/[+\s-]/g, '');
  if (cmd === 'pausatodo') { pausadoTodo = true; guardarPausadoTodo(); return res.send('PAUSADO TODO ✅'); }
  if (cmd === 'todo') { pausadoTodo = false; guardarPausadoTodo(); quitarTodosPausados(); return res.send('REACTIVADO TODO ✅ (incluye números individuales)'); }
  if (cmd === 'resumir') { pausadoTodo = false; guardarPausadoTodo(); return res.send('PAUSA GLOBAL QUITADA ✅ — números individuales siguen pausados'); }
  if (cmd === 'pausa' && numero) { marcarPausado(numero); return res.send('PAUSADO ✅ ' + numero); }
  if (cmd === 'reanudar' && numero) { quitarPausado(numero); return res.send('REACTIVADO ✅ ' + numero); }
  if (cmd === 'estado') return res.json({ pausadoTodo: pausadoTodo, numerosPausados: Object.keys(pausados), seguimientos: seguimientos });
  if (cmd === 'cerrado_venta' && numero) {
    marcarPausado(numero);
    seguimientos[numero] = { estado: 'cerrado_venta', timestamp: Date.now(), intentos: 0 };
    guardarSeguimiento(numero);
    return res.send('CERRADO VENTA ✅ ' + numero + ' — sin más seguimiento');
  }
  if (cmd === 'cerrado_perdido' && numero) {
    marcarPausado(numero);
    seguimientos[numero] = { estado: 'cerrado_perdido', timestamp: Date.now(), intentos: 0 };
    guardarSeguimiento(numero);
    return res.send('CERRADO PERDIDO ✅ ' + numero + ' — sin más seguimiento');
  }
  return res.send('Comando no reconocido.');
});

app.get('/', function(req, res) {
  res.json({ status: 'Agente Lili V10 activo', bd: bdLista, pausadoTodo: pausadoTodo, pausados: Object.keys(pausados).length, seguimientos: Object.keys(seguimientos).length });
});

app.get('/reporte', function(req, res) {
  if (req.query.token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');

  var todos = {};
  Object.keys(conversaciones).forEach(function(n) { if (n !== LILI_NUMERO) todos[n] = true; });
  Object.keys(seguimientos).forEach(function(n) { if (n !== LILI_NUMERO) todos[n] = true; });

  var cat = {
    en_conversacion: [], saludo_sin_respuesta: [], esperando_info: [],
    esperando_decision: [], cotizacion_enviada: [], cerrado_venta: [], cerrado_perdido: []
  };

  Object.keys(todos).forEach(function(n) {
    var seg = seguimientos[n];
    if (!seg) { cat.en_conversacion.push(n); }
    else if (cat[seg.estado]) { cat[seg.estado].push(n); }
    else { cat.en_conversacion.push(n); }
  });

  var totalLeads = Object.keys(todos).length;
  var etiquetas = {
    en_conversacion: '💬 En conversación / atendiendo',
    saludo_sin_respuesta: '👋 Saludaron y no respondieron',
    esperando_info: '📏 Prometieron enviar medidas/fotos',
    esperando_decision: '🖼️ Esperando decisión (fotos enviadas)',
    cotizacion_enviada: '📋 Cotización enviada',
    cerrado_venta: '✅ Venta cerrada',
    cerrado_perdido: '❌ Perdidos / cerrados'
  };

  var html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>Reporte de Leads</title><style>';
  html += 'body{font-family:-apple-system,sans-serif;background:#f5f3ef;margin:0;padding:20px;color:#3a342e}';
  html += 'h1{font-size:22px;margin-bottom:4px}.total{color:#7a7268;margin-bottom:24px;font-size:15px}';
  html += '.cat{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}';
  html += '.cat h2{font-size:16px;margin:0 0 10px}.count{float:right;background:#e8e3db;border-radius:20px;padding:2px 12px;font-size:14px}';
  html += '.num{font-family:monospace;font-size:14px;padding:5px 0;border-top:1px solid #f0ece6;color:#5a534b}';
  html += '.vacio{color:#aaa;font-size:13px;font-style:italic}';
  html += '</style></head><body>';
  html += '<h1>🌿 Reporte de Leads — Hecho por Lili</h1>';
  html += '<div class="total">Total de leads registrados: <b>' + totalLeads + '</b></div>';

  Object.keys(etiquetas).forEach(function(estado) {
    var lista = cat[estado];
    html += '<div class="cat"><h2>' + etiquetas[estado] + '<span class="count">' + lista.length + '</span></h2>';
    if (lista.length === 0) { html += '<div class="vacio">Ninguno por ahora</div>'; }
    else { lista.forEach(function(n) { html += '<div class="num">' + n + '</div>'; }); }
    html += '</div>';
  });

  html += '<div class="total" style="margin-top:20px;font-size:13px">Ahora los datos son permanentes — ya no se borran con los reinicios.</div>';
  html += '</body></html>';
  res.send(html);
});

function estadoLegible(numero) {
  var seg = seguimientos[numero];
  if (!seg) return pausados[numero] ? '⏸️ Pausado (atendiendo)' : '💬 En conversación';
  var map = {
    saludo_sin_respuesta: '👋 Saludó sin responder',
    esperando_info: '📏 Prometió medidas/fotos',
    esperando_decision: '🖼️ Esperando decisión',
    cotizacion_enviada: '📋 Cotización enviada',
    cerrado_venta: '✅ Venta cerrada',
    cerrado_perdido: '❌ Perdido / cerrado'
  };
  return map[seg.estado] || seg.estado;
}

app.get('/panel', function(req, res) {
  if (req.query.token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');
  var leads = Object.keys(conversaciones).filter(function(n) { return n !== LILI_NUMERO; });
  // Ordenar por última actividad: el lead con quien se habló más recientemente queda arriba
  leads.sort(function(a, b) {
    var ta = ultimaActividad[a] || 0;
    var tb = ultimaActividad[b] || 0;
    return tb - ta;
  });

  // Separar en dos grupos:
  // "Atendiendo yo" = leads pausados que NO están cerrados (Lili los está manejando)
  // "Olivia maneja" = el resto
  var mios = [];
  var deOlivia = [];
  leads.forEach(function(n) {
    var seg = seguimientos[n];
    var cerrado = seg && (seg.estado === 'cerrado_venta' || seg.estado === 'cerrado_perdido');
    if (pausados[n] && !cerrado) {
      mios.push(n);
    } else {
      deOlivia.push(n);
    }
  });

  function tarjetaLead(n) {
    var h = '<a class="lead" href="/panel/chat?token=' + CONTROL_TOKEN + '&numero=' + n + '">';
    h += '<div class="num">+' + n + '</div>';
    h += '<div class="est">' + estadoLegible(n) + '</div>';
    if (notas[n]) {
      h += '<div class="nota-prev">📝 ' + escapeHtml(notas[n]) + '</div>';
    }
    h += '</a>';
    return h;
  }

  function listaGrupo(arr) {
    if (arr.length === 0) return '<div class="vacio">No hay leads en este grupo.</div>';
    return arr.map(tarjetaLead).join('');
  }

  var html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>Panel — Hecho por Lili</title><style>';
  html += 'body{font-family:-apple-system,sans-serif;background:#f5f3ef;margin:0;padding:16px;color:#3a342e}';
  html += 'h1{font-size:20px;margin-bottom:12px}';
  html += '.tabs{display:flex;gap:8px;margin-bottom:16px}';
  html += '.tab{flex:1;text-align:center;padding:12px 8px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;background:#e8e3db;color:#7a7268;border:none}';
  html += '.tab.activa{background:#3a342e;color:#fff}';
  html += '.lead{display:block;background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:10px;text-decoration:none;color:#3a342e;box-shadow:0 1px 3px rgba(0,0,0,.06)}';
  html += '.num{font-family:monospace;font-size:15px;font-weight:600}';
  html += '.est{font-size:13px;color:#7a7268;margin-top:4px}';
  html += '.nota-prev{font-size:12px;color:#4a7c4e;margin-top:6px;background:#f0f5ee;padding:6px 8px;border-radius:6px}';
  html += '.vacio{color:#aaa;font-style:italic;padding:10px 0}';
  html += '.grupo{display:none}.grupo.activo{display:block}';
  html += '</style></head><body>';
  html += '<h1>🌿 Panel de Conversaciones</h1>';

  html += '<div class="tabs">';
  html += '<button class="tab activa" id="tab-mios" onclick="verGrupo(\'mios\')">🔵 Atendiendo yo (' + mios.length + ')</button>';
  html += '<button class="tab" id="tab-olivia" onclick="verGrupo(\'olivia\')">🟢 Olivia maneja (' + deOlivia.length + ')</button>';
  html += '</div>';

  html += '<div class="grupo activo" id="grupo-mios">' + listaGrupo(mios) + '</div>';
  html += '<div class="grupo" id="grupo-olivia">' + listaGrupo(deOlivia) + '</div>';

  html += '<script>';
  html += 'function verGrupo(g){';
  html += 'document.getElementById("grupo-mios").className = g==="mios" ? "grupo activo" : "grupo";';
  html += 'document.getElementById("grupo-olivia").className = g==="olivia" ? "grupo activo" : "grupo";';
  html += 'document.getElementById("tab-mios").className = g==="mios" ? "tab activa" : "tab";';
  html += 'document.getElementById("tab-olivia").className = g==="olivia" ? "tab activa" : "tab";';
  html += '}';
  html += '</script>';
  html += '</body></html>';
  res.send(html);
});

app.get('/panel/chat', function(req, res) {
  if (req.query.token !== CONTROL_TOKEN) return res.status(403).send('No autorizado');
  var numero = req.query.numero;
  if (numero) numero = numero.replace(/[+\s-]/g, '');
  var conv = conversaciones[numero] || [];

  var html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>+' + numero + '</title><style>';
  html += 'body{font-family:-apple-system,sans-serif;background:#e5ddd5;margin:0;padding:0;color:#3a342e}';
  html += '.top{background:#3a342e;color:#fff;padding:14px 16px;position:sticky;top:0}';
  html += '.top a{display:inline-block;color:#fff;background:rgba(255,255,255,.15);text-decoration:none;font-size:15px;padding:8px 14px;border-radius:8px;margin-bottom:10px}';
  html += '.top .n{font-family:monospace;font-size:16px;font-weight:600;margin-top:2px}';
  html += '.est{font-size:12px;color:#cdbfae;margin-top:2px}';
  html += '.wrap{padding:16px;padding-bottom:140px}';
  html += '.msg{max-width:78%;padding:9px 13px;border-radius:12px;margin-bottom:8px;font-size:15px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}';
  html += '.lead{background:#fff;align-self:flex-start;margin-right:auto}';
  html += '.lili{background:#d9fdd3;margin-left:auto}';
  html += '.row{display:flex}';
  html += '.vacio{color:#888;font-style:italic;padding:20px}';
  html += '.barra{position:fixed;bottom:0;left:0;right:0;background:#f0ece6;padding:10px;box-shadow:0 -1px 4px rgba(0,0,0,.1)}';
  html += '.barra textarea{width:100%;box-sizing:border-box;border:1px solid #cdbfae;border-radius:10px;padding:10px;font-size:15px;font-family:inherit;resize:vertical;min-height:44px}';
  html += '.fila{display:flex;gap:8px;margin-top:8px}';
  html += '.btn{flex:1;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer}';
  html += '.btn-enviar{background:#3a342e;color:#fff}';
  html += '.btn-agente{background:#e8e3db;color:#3a342e}';
  html += '.marcar-titulo{font-size:11px;color:#7a7268;text-align:center;margin-top:10px;margin-bottom:6px}';
  html += '.fila-marcar{display:flex;gap:6px}';
  html += '.btn-marcar{flex:1;border:1px solid #cdbfae;background:#fff;color:#5a534b;border-radius:8px;padding:9px 4px;font-size:12px;font-weight:600;cursor:pointer}';
  html += '.btn-cerrar{flex:1;border:none;border-radius:8px;padding:10px 4px;font-size:12px;font-weight:600;cursor:pointer;color:#fff}';
  html += '.btn-venta{background:#4a7c4e}';
  html += '.btn-perdido{background:#a85a4a}';
  html += '.nota-input{width:100%;box-sizing:border-box;border:1px solid #cdbfae;border-radius:8px;padding:9px;font-size:14px;font-family:inherit;resize:vertical;min-height:50px;margin-bottom:6px}';
  html += '.btn-nota{width:100%;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;background:#4a7c4e;color:#fff}';
  html += '.acciones-panel{display:none;max-height:55vh;overflow-y:auto;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #cdbfae}';
  html += '.acciones-panel.abierto{display:block}';
  html += '.btn-acciones{background:#8a7f70;color:#fff}';
  html += '.btn-accion-full{width:100%;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:4px}';
  html += '.aviso{font-size:12px;color:#7a7268;text-align:center;margin-top:6px}';
  html += '</style></head><body>';
  html += '<div class="top"><a href="/panel?token=' + CONTROL_TOKEN + '">← Volver a leads</a>';
  html += '<div class="n">+' + numero + '</div>';
  html += '<div class="est">' + estadoLegible(numero) + '</div></div>';
  html += '<div class="wrap">';

  if (conv.length === 0) {
    html += '<div class="vacio">No hay mensajes guardados de este número.</div>';
  } else {
    conv.forEach(function(m) {
      var clase = m.role === 'user' ? 'lead' : 'lili';
      html += '<div class="row"><div class="msg ' + clase + '">' + escapeHtml(m.content) + '</div></div>';
    });
  }
  html += '</div>';

  var estaPausado = pausados[numero] ? true : false;
  html += '<div class="barra">';

  // Panel de acciones desplegable (arranca oculto)
  html += '<div id="acciones" class="acciones-panel">';
  html += '<div class="aviso">' + (estaPausado ? 'El agente está pausado — tú atiendes este lead' : 'El agente está activo en este lead') + '</div>';
  if (estaPausado) {
    html += '<button class="btn-accion-full btn-agente" onclick="agente(\'reanudar\')">▶️ Activar agente Olivia</button>';
  } else {
    html += '<button class="btn-accion-full btn-agente" onclick="agente(\'pausa\')">⏸️ Pausar agente (atiendo yo)</button>';
  }
  html += '<div class="marcar-titulo">Avisarle al agente que ya enviaste (por WhatsApp):</div>';
  html += '<div class="fila-marcar">';
  html += '<button class="btn-marcar" onclick="marcar(\'esperando_decision\',event)">📸 Fotos enviadas</button>';
  html += '<button class="btn-marcar" onclick="marcar(\'cotizacion_enviada\',event)">📋 Cotización enviada</button>';
  html += '<button class="btn-marcar" onclick="marcar(\'esperando_info\',event)">📏 Espero medidas</button>';
  html += '</div>';
  html += '<div class="marcar-titulo">Cerrar este lead:</div>';
  html += '<div class="fila-marcar">';
  html += '<button class="btn-cerrar btn-venta" onclick="cerrar(\'cerrado_venta\',event)">✅ Venta cerrada</button>';
  html += '<button class="btn-cerrar btn-perdido" onclick="cerrar(\'cerrado_perdido\',event)">❌ No va a comprar</button>';
  html += '</div>';
  html += '<div class="marcar-titulo">📝 Nota privada (lo que hablaste por audio, qué esperas, etc.):</div>';
  html += '<textarea id="nota" class="nota-input" placeholder="Ej: Quedó de mandar fotos del material el viernes...">' + escapeHtml(notas[numero] || '') + '</textarea>';
  html += '<button class="btn-nota" onclick="guardarNota(event)">Guardar nota</button>';
  html += '</div>';

  // Fila fija esencial: texto + Enviar + Acciones
  html += '<textarea id="txt" placeholder="Escribe tu respuesta..."></textarea>';
  html += '<div class="fila">';
  html += '<button class="btn btn-enviar" onclick="enviar(event)">Enviar</button>';
  html += '<button class="btn btn-acciones" onclick="toggleAcciones()">⚙️ Acciones</button>';
  html += '</div>';
  html += '</div>';

  html += '<script>';
  html += 'var NUM="' + numero + '";var TK="' + CONTROL_TOKEN + '";';
  html += 'function enviar(e){';
  html += 'var t=document.getElementById("txt").value.trim();if(!t)return;';
  html += 'var b=e.target;b.disabled=true;b.textContent="Enviando...";';
  html += 'fetch("/panel/enviar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM,texto:t})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.reload()}else{alert("Error al enviar");b.disabled=false;b.textContent="Enviar"}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="Enviar"});}';
  html += 'function agente(cmd){fetch("/control?cmd="+cmd+"&numero="+NUM+"&token="+TK).then(function(){location.reload()});}';
  html += 'function marcar(estado,e){';
  html += 'var b=e.target;var orig=b.textContent;b.disabled=true;b.textContent="✓ Listo";';
  html += 'fetch("/panel/marcar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM,estado:estado})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){setTimeout(function(){location.reload()},700)}else{alert("Error");b.disabled=false;b.textContent=orig}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent=orig});}';
  html += 'function cerrar(cmd,e){';
  html += 'var msg=cmd==="cerrado_venta"?"¿Marcar este lead como VENTA CERRADA? Se detiene todo el seguimiento.":"¿Marcar este lead como PERDIDO? Se detiene todo el seguimiento.";';
  html += 'if(!confirm(msg))return;';
  html += 'var b=e.target;b.disabled=true;b.textContent="✓ Listo";';
  html += 'fetch("/control?cmd="+cmd+"&numero="+NUM+"&token="+TK)';
  html += '.then(function(){setTimeout(function(){location.reload()},700)})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;});}';
  html += 'window.scrollTo(0, document.body.scrollHeight);';
  html += 'function toggleAcciones(){';
  html += 'var p=document.getElementById("acciones");';
  html += 'p.className = p.className.indexOf("abierto")===-1 ? "acciones-panel abierto" : "acciones-panel";';
  html += '}';
  html += 'function guardarNota(e){';
  html += 'var t=document.getElementById("nota").value;';
  html += 'var b=e.target;b.disabled=true;b.textContent="Guardando...";';
  html += 'fetch("/panel/nota",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM,nota:t})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){b.textContent="✓ Nota guardada";setTimeout(function(){b.disabled=false;b.textContent="Guardar nota"},1500)}else{alert("Error");b.disabled=false;b.textContent="Guardar nota"}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="Guardar nota"});}';
  html += '</script>';
  html += '</body></html>';
  res.send(html);
});

app.post('/panel/enviar', function(req, res) {
  if (req.body.token !== CONTROL_TOKEN) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  var texto = req.body.texto || '';
  if (!numero || !texto) return res.json({ ok: false });

  marcarPausado(numero);
  if (!conversaciones[numero]) conversaciones[numero] = [];
  conversaciones[numero].push({ role: 'assistant', content: texto });
  if (conversaciones[numero].length > 12) conversaciones[numero] = conversaciones[numero].slice(-12);
  guardarConversacion(numero);
  cancelarSeguimiento(numero);

  enviarMensaje(numero, texto);
  console.log('Respuesta manual desde panel a ' + numero);
  res.json({ ok: true });
});

// Endpoint para marcar un estado de seguimiento desde el panel
// (cuando Lili envía fotos/cotización/referencias por fuera y quiere avisarle al agente)
app.post('/panel/marcar', function(req, res) {
  if (req.body.token !== CONTROL_TOKEN) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  var estado = req.body.estado || '';
  var estadosValidos = ['esperando_info', 'esperando_decision', 'cotizacion_enviada'];
  if (!numero || estadosValidos.indexOf(estado) === -1) return res.json({ ok: false });

  // Activar el seguimiento con el estado indicado (resetea timer e intentos)
  seguimientos[numero] = { estado: estado, timestamp: Date.now(), intentos: 0 };
  guardarSeguimiento(numero);
  console.log('Estado marcado desde panel para ' + numero + ': ' + estado);
  res.json({ ok: true });
});

// Endpoint para guardar la nota privada de un lead
app.post('/panel/nota', function(req, res) {
  if (req.body.token !== CONTROL_TOKEN) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!numero) return res.json({ ok: false });
  var nota = (req.body.nota || '').slice(0, 1000); // límite de seguridad
  if (nota.trim() === '') { delete notas[numero]; } else { notas[numero] = nota; }
  guardarNota(numero);
  console.log('Nota guardada para ' + numero);
  res.json({ ok: true });
});

function escapeHtml(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
    if (value.statuses) { return; }

    if (value.messages) {
      var message = value.messages[0];
      var esSaliente = false;
      if (message.from && message.from === PHONE_NUMBER_ID) esSaliente = true;

      if (esSaliente && message.type === 'text') {
        var leadNumero = message.to || null;
        if (leadNumero) {
          marcarPausado(leadNumero);
          console.log('Lili escribió a ' + leadNumero + ' — número pausado automáticamente');
          if (!conversaciones[leadNumero]) conversaciones[leadNumero] = [];
          conversaciones[leadNumero].push({ role: 'assistant', content: message.text.body });
          if (conversaciones[leadNumero].length > 12) conversaciones[leadNumero] = conversaciones[leadNumero].slice(-12);
          guardarConversacion(leadNumero);
          var estadoDetectado = detectarEstadoPorMensajeLili(message.text.body);
          if (estadoDetectado) {
            activarSeguimiento(leadNumero, estadoDetectado);
            console.log('Estado seguimiento activado para ' + leadNumero + ': ' + estadoDetectado);
          }
        }
        return;
      }

      if (message && message.type === 'text') {
        var from = message.from;
        var texto = message.text.body;
        console.log('Mensaje de ' + from + ': ' + texto);

        // GUARDAR SIEMPRE el mensaje del lead en la BD, aunque esté pausado.
        // Así Lili ve todas las respuestas en el panel para hacer seguimiento.
        // La pausa solo evita que el AGENTE responda solo — no que se registre el mensaje.
        if (!conversaciones[from]) conversaciones[from] = [];
        conversaciones[from].push({ role: 'user', content: texto });
        if (conversaciones[from].length > 12) conversaciones[from] = conversaciones[from].slice(-12);
        guardarConversacion(from);

        cancelarSeguimiento(from);

        if (leadPrometioInfo(texto) && !pausados[from]) {
          setTimeout(function() {
            if (!pausados[from]) { activarSeguimiento(from, 'esperando_info'); }
          }, 2000);
        }

        if (pausadoTodo) { console.log('Pausado global (mensaje guardado, agente no responde)'); return; }
        if (pausados[from]) { console.log('Numero pausado (mensaje guardado, agente no responde): ' + from); return; }
        if (procesando[from]) { console.log('Ya procesando mensaje de: ' + from); return; }

        procesando[from] = true;
        setTimeout(function() { procesarMensaje(from, texto); }, 500);
      }
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

function procesarMensaje(from, texto) {
  // El mensaje del lead ya fue agregado al historial y guardado en el webhook.
  // Aquí solo generamos la respuesta del agente.
  if (!conversaciones[from]) conversaciones[from] = [];

  // Detectar si es el primer mensaje (saludo inicial) para mandar fotos primero
  var esPrimerMensaje = conversaciones[from].filter(function(m) { return m.role === 'assistant'; }).length === 0;

  axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5', max_tokens: 600, system: SYSTEM_PROMPT, messages: conversaciones[from] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  ).then(function(response) {
    var respuesta = response.data.content[0].text;
    console.log('Claude: ' + respuesta);
    conversaciones[from].push({ role: 'assistant', content: respuesta });
    guardarConversacion(from);

    var necesitaEscalar = respuesta.indexOf('[ESCALAR]') !== -1;
    var necesitaFotosExtra = respuesta.indexOf('[FOTOS_EXTRA]') !== -1;
    var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').replace(/\[FOTOS_EXTRA\]/g, '').trim();

    if (necesitaEscalar) {
      notificarLili(from, texto.substring(0, 100));
      marcarPausado(from);
      console.log('Escalado. Numero pausado: ' + from);
    } else {
      if (!seguimientos[from] || (seguimientos[from].estado !== 'cerrado_venta' && seguimientos[from].estado !== 'cerrado_perdido' && seguimientos[from].estado !== 'esperando_info' && seguimientos[from].estado !== 'esperando_decision' && seguimientos[from].estado !== 'cotizacion_enviada')) {
        seguimientos[from] = { estado: 'saludo_sin_respuesta', timestamp: Date.now(), intentos: 0, ultimoMensajeLead: Date.now() };
        guardarSeguimiento(from);
      }
    }

    // Si es el primer mensaje: fotos primero, luego el texto del saludo
    if (esPrimerMensaje) {
      enviarFotosSaludo(from)
        .then(function() {
          return new Promise(function(resolve) { setTimeout(resolve, 1000); });
        })
        .then(function() {
          enviarMensaje(from, textoLimpio);
        });
    } else if (necesitaFotosExtra) {
      // Si Olivia detectó que piden más fotos: texto primero, luego las fotos extra
      enviarMensaje(from, textoLimpio);
      setTimeout(function() { enviarFotosExtra(from); }, 1500);
    } else {
      enviarMensaje(from, textoLimpio);
    }

    delete procesando[from];
  }).catch(function(error) {
    console.error('Error Claude:', error.response ? JSON.stringify(error.response.data) : error.message);
    delete procesando[from];
    enviarMensaje(from, 'Hola! 🙌 Estoy revisando tu mensaje, en un momento te respondo 😊');
  });
}

// ─── FOTOS DE PRODUCTO ────────────────────────────────────────────────────
const FOTOS = {
  principal:    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1781466273/file_000000005ba4722fac900f399e5dc35f_dnlkjv.png',
  acompanante:  'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1781465915/file_00000000f730720eac95c2814d66aa6b_atssh8.png',
  extra_1:      'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1781465915/file_00000000cc80720e95b69a0a306ecad4_jx0bhd.png',
  extra_2:      'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1781466273/file_000000001f2c722faca1ee2a52bc9acd_cpegru.png'
};

function enviarImagen(to, urlFoto, caption) {
  var body = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'image',
    image: { link: urlFoto }
  };
  if (caption) body.image.caption = caption;
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    body,
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Imagen enviada a ' + to + ': ' + urlFoto);
  }).catch(function(error) {
    console.error('Error imagen:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

// Envía las dos fotos del saludo en secuencia (principal + acompañante)
function enviarFotosSaludo(to) {
  return enviarImagen(to, FOTOS.principal)
    .then(function() {
      return new Promise(function(resolve) { setTimeout(resolve, 1500); });
    })
    .then(function() {
      return enviarImagen(to, FOTOS.acompanante);
    });
}

// Envía fotos extra cuando el lead pide más imágenes
function enviarFotosExtra(to) {
  return enviarImagen(to, FOTOS.extra_1)
    .then(function() {
      return new Promise(function(resolve) { setTimeout(resolve, 1500); });
    })
    .then(function() {
      return enviarImagen(to, FOTOS.extra_2);
    });
}
// ─── FIN FOTOS ─────────────────────────────────────────────────────────────

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

// Arrancar: primero conectar a la BD, luego levantar el servidor
inicializarBD().then(function() {
  app.listen(PORT, function() {
    console.log('Agente Lili V10 (PostgreSQL) en puerto ' + PORT);
  });
});

module.exports = app;
