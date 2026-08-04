require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

const app = express();
app.use(express.json({
  verify: function(req, res, buf) { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
// 🆕 ETAPA 0 (3 ago) — App ID de Meta, necesario para extender el Page
// Access Token de corta a larga duración (ver obtenerPageAccessToken()).
// No es secreto (los App IDs de Meta son públicos), por eso el default.
const META_APP_ID = process.env.META_APP_ID || '1413208417309453';
// 🆕 ETAPA 0 — FIX RÁPIDO (3 ago) — fallback manual si META_API_TOKEN no
// tiene permiso para listar páginas (me/accounts devuelve 0 páginas). Se
// pone a mano en Railway un Page Access Token ya generado — ver
// obtenerPageAccessToken() para el orden de intentos.
const PAGE_ACCESS_TOKEN_ENV = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;
const LILI_NUMERO = process.env.LILI_NUMERO;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

// 🆕 COTIZADOR V2 REPISAS — FASE 5 (26 jul) — feature flag. Por defecto
// (variable ausente o distinta de 'true') el bloque del tag
// [COTIZAR_REPISA:...] NUNCA se agrega al system prompt — Olivia se
// comporta exactamente igual que hoy, sin ningún riesgo. Se activa
// poniendo COTIZADOR_REPISAS_V2_ENABLED=true en las variables de Railway
// (requiere redeploy) — permite probar con un lead real antes de decidir
// si se deja activo para todos. Función (no const de arranque) para que
// las pruebas puedan alternarlo dentro de la misma ejecución de Node.
function cotizadorRepisasV2Habilitado() {
  return process.env.COTIZADOR_REPISAS_V2_ENABLED === 'true';
}

// 🆕 FEATURE FLAG (2 ago 2026) — mismo patrón exacto que
// cotizadorRepisasV2Habilitado(): por defecto (variable ausente o distinta
// de 'true') el cron de reactivación de 12pm/7pm (más abajo, el segundo
// setInterval) NO envía nada — Olivia sigue respondiendo en tiempo real
// normalmente, esto solo apaga ese cron puntual. Se activa poniendo
// REACTIVACION_12_19_ENABLED=true en las variables de Railway (requiere
// redeploy). Se agregó tras el incidente del 2 de agosto donde cmd=todo en
// /control vació la tabla `pausados` — mientras se audita y corrige el
// resto del sistema de seguimiento (texto hardcodeado de "repisa" para
// cualquier producto, ver docs/PENDIENTES.md), este cron queda apagado por
// defecto para no volver a mandar mensajes automáticos incorrectos.
function reactivacion1219Habilitada() {
  return process.env.REACTIVACION_12_19_ENABLED === 'true';
}

function esNumeroValido(n) {
  return typeof n === 'string' && /^\d{5,20}$/.test(n);
}

// 🆕 ETAPA 1 (3 ago 2026) — jerarquía de resolución del número del
// remitente. `message.from` es la fuente principal, pero Meta a veces lo
// manda vacío/corrupto en el mismo payload donde `value.contacts[0].wa_id`
// sí trae el número real (caso real: lead "Yuly"). Nunca inventa ni
// adivina más allá de estas dos fuentes — si ninguna pasa esNumeroValido,
// devuelve null y quien llama debe alertar en vez de perder el mensaje.
function resolverNumeroRemitente(message, contacts) {
  if (message && esNumeroValido(message.from)) return message.from;
  if (Array.isArray(contacts) && contacts[0] && esNumeroValido(contacts[0].wa_id)) return contacts[0].wa_id;
  return null;
}

// Único lugar que decide si un mensaje entrante de WhatsApp va a ser
// procesado por alguna de las ramas del webhook (texto saliente de Lili,
// texto entrante, o media entrante). Antes de esto, un message.type fuera
// de esos casos (interactive, button, contacts, location, sticker,
// reaction, order, system, unsupported...) o un `from` que no pasara
// esNumeroValido simplemente no encajaba en ningún `if` del webhook y se
// perdía sin ningún log ni error — fallo real detectado con un lead real
// (María, 29 jul 2026) cuyo mensaje nunca llegó a "🆕 Lead creado" ni a
// "Mensaje de...". `esSaliente` se recibe ya calculado por el llamador
// (depende de PHONE_NUMBER_ID, definido más abajo en el archivo).
// `numeroResuelto` viene ya calculado por resolverNumeroRemitente() —
// evita que esta función tenga su propia noción distinta de "número válido".
function tipoDeMensajeEsManejado(message, esSaliente, numeroResuelto) {
  if (!message) return false;
  if (esSaliente && message.type === 'text') return true;
  if (message.type === 'text' && numeroResuelto) return true;
  if ((message.type === 'image' || message.type === 'video' || message.type === 'audio' || message.type === 'document') && numeroResuelto) return true;
  return false;
}

function tokenValido(provisto, esperado) {
  return !!esperado && provisto === esperado;
}

function firmaWebhookValida(req) {
  if (!META_APP_SECRET) return false;
  var firma = req.get('x-hub-signature-256');
  if (!firma || !req.rawBody) return false;
  var esperada = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  var bufFirma = Buffer.from(firma);
  var bufEsperada = Buffer.from(esperada);
  if (bufFirma.length !== bufEsperada.length) return false;
  return crypto.timingSafeEqual(bufFirma, bufEsperada);
}

// 🆕 FASE 1A, PASO 11 — `let` en vez de `const` únicamente para permitir que
// las pruebas inyecten un pool simulado (ver app.__setPoolParaPruebas más
// abajo). En producción nunca se reasigna — sigue siendo el mismo Pool real
// de siempre, con la misma configuración.
let pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const conversaciones = {};
const pausados = {};
const seguimientos = {};
const notas = {};
const ultimaActividad = {};
const procesando = {};

// 🆕 Lock síncrono contra condición de carrera (auditoría 2 ago 2026, lead
// real Fernando Escobar: 3 mensajes en ~7s — el guard vivía dentro del
// .then() de capturarMensajeCRM(), es decir DESPUÉS de un round-trip async a
// la BD, así que dos mensajes en ráfaga pasaban el guard a la vez: uno se
// perdía en silencio, el otro disparaba un saludo genérico ignorando lo ya
// hablado). La reclamación debe ejecutarse en el mismo tick síncrono del
// webhook, antes de cualquier await/promesa — nunca dentro de un .then().
// Devuelve true si el lock YA estaba tomado por OTRO mensaje de ese número
// (quien llama no debe tocarlo al bailar); false si lo acabamos de reclamar
// nosotros (quien llama debe liberarlo con liberarLockSiLoReclamamos() si
// decide no seguir hasta procesarMensaje()).
function reclamarLockProcesando(numero) {
  var yaHabiaMensajeEnProceso = !!procesando[numero];
  if (!yaHabiaMensajeEnProceso) procesando[numero] = true;
  return yaHabiaMensajeEnProceso;
}

// Libera procesando[numero] SOLO si quien llama fue quien lo reclamó
// (yaHabiaMensajeEnProceso === false) — nunca libera el lock de otro mensaje.
function liberarLockSiLoReclamamos(numero, yaHabiaMensajeEnProceso) {
  if (!yaHabiaMensajeEnProceso) delete procesando[numero];
}

let pausadoTodo = false;
let bdLista = false;
// 🆕 ETAPA 0 (3 ago) — Page Access Token derivado al arranque (ver
// obtenerPageAccessToken()), usado solo para la Graph API de Lead Ads
// (leads_retrieval). Nunca se usa para WhatsApp — eso sigue con META_API_TOKEN.
let pageAccessToken = null;

// Helper: agrega mensaje al historial CON timestamp
function agregarMensaje(numero, role, contenido) {
  if (!conversaciones[numero]) conversaciones[numero] = [];
  conversaciones[numero].push({ role: role, content: contenido, ts: Date.now() });
  if (conversaciones[numero].length > 12) conversaciones[numero] = conversaciones[numero].slice(-12);
  guardarConversacion(numero);
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 COTIZADOR V2 REPISAS (26 jul) — siembra idempotente de precios_repisas
// desde data/precios_repisas_v2.csv. Parser propio (fs.readFileSync +
// split), sin dependencia nueva — verificado que ningún campo del CSV real
// (incluida `alerta`) trae comas ni comillas internas, así que un split
// simple por línea/coma es seguro.
// ═══════════════════════════════════════════════════════════════════════════
const RUTA_CSV_PRECIOS_REPISAS = path.join(__dirname, 'data', 'precios_repisas_v2.csv');
const CAMPOS_NUMERICOS_PRECIOS_REPISAS = [
  'prof_cm', 'largo_cm', 'costo_real_instalado', 'tecnico_instalado', 'comercial_instalado',
  'costo_real_enviado', 'tecnico_enviado', 'comercial_enviado', 'envio_real_estimado', 'precio_minimo_aprobado'
];

function parsearCsvPreciosRepisas(contenido) {
  var lineas = contenido.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l !== ''; });
  var columnas = lineas[0].split(',');
  return lineas.slice(1).map(function(linea) {
    var valores = linea.split(',');
    var fila = {};
    columnas.forEach(function(nombreColumna, i) {
      fila[nombreColumna] = valores[i] !== undefined ? valores[i] : '';
    });
    CAMPOS_NUMERICOS_PRECIOS_REPISAS.forEach(function(campo) { fila[campo] = Number(fila[campo]); });
    return fila;
  });
}

// requiere_aprobacion_descuento = true cuando: la fila trae una alerta
// explícita, O el comercial ya está en/por debajo del técnico (margen
// agotado), O es una "pequeña profunda" sensible (profundidad 25/30cm con
// largo < 50cm) — criterio exacto acordado con Lili.
function calcularRequiereAprobacionDescuento(fila) {
  var tieneAlerta = !!(fila.alerta && String(fila.alerta).trim() !== '');
  var margenAgotado = fila.comercial_instalado <= fila.tecnico_instalado;
  var pequenaProfunda = (fila.prof_cm === 25 || fila.prof_cm === 30) && fila.largo_cm < 50;
  return tieneAlerta || margenAgotado || pequenaProfunda;
}

async function sembrarPreciosRepisas() {
  var contenido;
  try {
    contenido = fs.readFileSync(RUTA_CSV_PRECIOS_REPISAS, 'utf8');
  } catch (e) {
    console.error('⚠️ No se pudo leer ' + RUTA_CSV_PRECIOS_REPISAS + ' — precios_repisas no se sembró:', e.message);
    return;
  }

  var filas = parsearCsvPreciosRepisas(contenido);
  for (var i = 0; i < filas.length; i++) {
    var fila = filas[i];
    var requiereAprobacion = calcularRequiereAprobacionDescuento(fila);
    try {
      await pool.query(
        'INSERT INTO precios_repisas (prof_cm, largo_cm, costo_real_instalado, tecnico_instalado, comercial_instalado, ' +
        'costo_real_enviado, tecnico_enviado, comercial_enviado, envio_real_estimado, precio_minimo_aprobado, alerta, requiere_aprobacion_descuento) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ' +
        'ON CONFLICT (prof_cm, largo_cm) DO UPDATE SET ' +
        'costo_real_instalado = $3, tecnico_instalado = $4, comercial_instalado = $5, ' +
        'costo_real_enviado = $6, tecnico_enviado = $7, comercial_enviado = $8, ' +
        'envio_real_estimado = $9, precio_minimo_aprobado = $10, alerta = $11, requiere_aprobacion_descuento = $12',
        [
          fila.prof_cm, fila.largo_cm, fila.costo_real_instalado, fila.tecnico_instalado, fila.comercial_instalado,
          fila.costo_real_enviado, fila.tecnico_enviado, fila.comercial_enviado, fila.envio_real_estimado,
          fila.precio_minimo_aprobado, fila.alerta || '', requiereAprobacion
        ]
      );
    } catch (e) {
      console.error('Error sembrando precios_repisas (' + fila.prof_cm + 'x' + fila.largo_cm + '):', e.message);
    }
  }
  console.log('💲 precios_repisas sembrado: ' + filas.length + ' filas desde el CSV');
  await cargarPreciosRepisasEnMemoria();
}

var preciosRepisas = []; // cargado al arrancar desde precios_repisas, usado por getSystemPrompt() y resolverPrecioRepisa()

async function cargarPreciosRepisasEnMemoria() {
  try {
    var r = await pool.query('SELECT * FROM precios_repisas ORDER BY prof_cm, largo_cm');
    preciosRepisas = r.rows;
    console.log('💲 precios_repisas cargado en memoria: ' + preciosRepisas.length + ' filas');
  } catch (e) {
    console.error('Error cargando precios_repisas en memoria:', e.message);
  }
}

// Arma el catálogo v2 (solo comercial_instalado, Modo 1 por defecto) agrupado
// por profundidad, para getSystemPrompt(). Reemplaza el catálogo v1 de
// repisas (ver integración pendiente — no se ha tocado getSystemPrompt() todavía).
function construirCatalogoRepisasV2() {
  if (preciosRepisas.length === 0) return '(catálogo de repisas no disponible — escalar cualquier cotización)';

  var porProfundidad = {};
  preciosRepisas.forEach(function(fila) {
    if (!porProfundidad[fila.prof_cm]) porProfundidad[fila.prof_cm] = [];
    porProfundidad[fila.prof_cm].push(fila);
  });

  var profundidades = Object.keys(porProfundidad).map(Number).sort(function(a, b) { return a - b; });
  return profundidades.map(function(prof) {
    var filas = porProfundidad[prof].slice().sort(function(a, b) { return a.largo_cm - b.largo_cm; });
    var lineas = filas.map(function(f) {
      return '  ' + f.largo_cm + 'cm → $' + f.comercial_instalado.toLocaleString('es-CO');
    });
    return 'Profundidad ' + prof + 'cm:\n' + lineas.join('\n');
  }).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 6 — COTIZADOR V2 REPISAS (27 jul) — cálculo real por fórmula,
// desde los parámetros base del Excel "Parametros" v1/v2 (aprobado por
// Lili con 3 ejemplos verificados a mano: 110×25=$380.000,
// 175×20=$460.000, 95×30=$420.000). Reemplaza la interpolación lineal
// anterior para cualquier combinación de largo×profundidad que NO esté
// en las 66 filas exactas del CSV, dentro de límites seguros — ver
// elegibleParaFormulaRepisa() más abajo para las condiciones exactas.
//
// Pura y aislada de resolverPrecioRepisa() a propósito, para poder
// probarla sola (ver test/cotizador-v2.test.js). NUNCA deduce sus
// parámetros (umbrales de tamaño, costos de barniz/mano de obra/soportes)
// del CSV — el CSV tiene ajustes manuales fila por fila (columna
// `alerta`) que no reflejan la fórmula pura; los valores de abajo son los
// que Lili confirmó explícitamente, no una inferencia.
// ═══════════════════════════════════════════════════════════════════════════
var COSTO_MATERIAL_POR_CM2_REPISA = 600000 / (244 * 122); // hoja de roble 244×122cm a $600.000
var FIJOS_INSTALADO_MEDELLIN_REPISA = 30000 + 30000 + 8000; // instalación + transporte/buffer + consumibles

var BARNIZ_POR_TAMANO_REPISA = { pequena: 5000, mediana: 10000, grande: 15000 };
var MANO_OBRA_POR_TAMANO_REPISA = { pequena: 15000, mediana: 20000, grande: 35000 };

// Regla de prioridad confirmada por Lili: si largo>120 O profundidad>25,
// es "grande/profunda" aunque la otra dimensión sea menor. Si no, es
// "pequeña" solo cuando AMBAS dimensiones son chicas; el resto es
// "mediana" (rango por defecto).
function clasificarTamanoRepisa(largoCm, profundidadCm) {
  if (largoCm > 120 || profundidadCm > 25) return 'grande';
  if (largoCm <= 50 && profundidadCm <= 15) return 'pequena';
  return 'mediana';
}

function cantidadSoportesRepisa(largoCm) {
  if (largoCm <= 80) return 2;
  if (largoCm <= 140) return 3;
  return 4; // 150-200cm — fuera de este rango ya no es elegible para fórmula
}

// 3 categorías de soporte confirmadas por Lili (reemplaza la regla
// anterior de solo 2 categorías): 10cm→soporte 12cm, 15cm y 20cm
// COMPARTEN el soporte 18cm, 25cm y 30cm comparten el soporte 25cm.
function costoUnitarioSoporteRepisa(profundidadCm) {
  if (profundidadCm === 10) return 5000;
  if (profundidadCm === 15 || profundidadCm === 20) return 7000;
  return 10000; // 25 o 30
}

function calcularPrecioRepisaDesdeFormula(largoCm, profundidadCm) {
  var areaCm2 = (largoCm + 1) * (profundidadCm + 1) * 2;
  var costoMaterial = areaCm2 * COSTO_MATERIAL_POR_CM2_REPISA;
  var tamano = clasificarTamanoRepisa(largoCm, profundidadCm);
  var barniz = BARNIZ_POR_TAMANO_REPISA[tamano];
  var manoObra = MANO_OBRA_POR_TAMANO_REPISA[tamano];
  var soportes = cantidadSoportesRepisa(largoCm) * costoUnitarioSoporteRepisa(profundidadCm);
  var costoReal = costoMaterial + barniz + manoObra + soportes + FIJOS_INSTALADO_MEDELLIN_REPISA;
  var valorTecnico = costoReal / 0.65;
  // Redondeo hacia arriba MATEMÁTICO explícito (Math.ceil), nunca
  // Math.round — protege el margen siempre, decisión explícita de Lili.
  var precioComercial = Math.ceil(valorTecnico / 10000) * 10000;

  return {
    largoCm: largoCm,
    profundidadCm: profundidadCm,
    areaCm2: areaCm2,
    costoMaterial: costoMaterial,
    tamano: tamano,
    barniz: barniz,
    manoObra: manoObra,
    soportes: soportes,
    fijos: FIJOS_INSTALADO_MEDELLIN_REPISA,
    costoReal: costoReal,
    valorTecnico: valorTecnico,
    precioComercial: precioComercial
  };
}

// Condiciones seguras para usar la fórmula en vez de escalar — TODAS
// deben cumplirse. Fuera de esto, resolverPrecioRepisa() siempre escala
// (ver el bloque de guardas más abajo para los mensajes específicos).
var PROFUNDIDADES_ELEGIBLES_FORMULA_REPISA = [10, 15, 20, 25, 30];
var LARGO_MIN_FORMULA_REPISA = 20;
var LARGO_MAX_FORMULA_REPISA = 200;

function elegibleParaFormulaRepisa(largoCm, profundidadCm, modalidad) {
  return modalidad === 'instalado' &&
    PROFUNDIDADES_ELEGIBLES_FORMULA_REPISA.indexOf(profundidadCm) !== -1 &&
    largoCm >= LARGO_MIN_FORMULA_REPISA && largoCm <= LARGO_MAX_FORMULA_REPISA;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 7 (27 jul) — capa determinística de respaldo. Confirmado con 3
// pruebas reales consecutivas: Claude puede CONSERVAR el contexto de la
// medida (la menciona correctamente en su respuesta) pero aun así elige
// escalar en lenguaje natural en vez de emitir [COTIZAR_REPISA:...] — es
// una decisión del modelo, no un problema de memoria ni del prompt (ya se
// reforzó 3 veces en esta misma sesión). En vez de seguir peleando por
// prompt, esta función detecta desde el HISTORIAL + el mensaje actual,
// sin depender de que Claude coopere, si hay una cotización de repisa
// segura para resolver — procesarMensaje() la usa para anular un
// [ESCALAR] de Claude cuando corresponde (ver más abajo).
//
// Pura y testeable: no toca la BD, no llama a Claude, NUNCA calcula
// precios (eso lo sigue haciendo exclusivamente resolverPrecioRepisa(),
// sin cambios). Solo EXTRAE los parámetros; ante cualquier señal de caso
// especial o ambigüedad, devuelve null y el escalamiento de Claude se
// respeta tal cual — nunca inventa ni asume de más.
// ═══════════════════════════════════════════════════════════════════════════
var REGEX_MEDIDA_REPISA = /(\d{1,3})\s*[x×]\s*(\d{1,3})\s*(cm)?/i;
// Palabras/medidas que indican un caso especial (entamborada, tipo caja,
// espesor distinto a 3.6/3cm) — cualquiera de estas bloquea la detección,
// sin importar dónde aparezca en el historial reciente.
var REGEX_ESPESOR_ESPECIAL_REPISA = /4[.,]5\s*cm|5[.,]4\s*cm|\b5\s*cm\b|entamborada|tipo\s+caja|gruesa/i;

// Área metropolitana de Medellín → modalidad instalado_medellin (mismo
// criterio que "es el valor por defecto si no queda claro que es de otra
// ciudad" del prompt). Ciudades reconocidas de la tabla de envíos →
// envio_nacional (resolverPrecioRepisa ya se encarga de exigir fila
// exacta o escalar, esta función no inventa envío). Ciudad no reconocida
// → detección insegura, se descarta (return null).
var CIUDADES_AREA_METRO_MEDELLIN_REPISA = ['medellin', 'medellín', 'envigado', 'sabaneta', 'itagui', 'itagüí', 'bello', 'la estrella', 'caldas', 'copacabana', 'girardota'];
var CIUDADES_RECONOCIDAS_ENVIO_REPISA = ['bogota', 'bogotá', 'cali', 'barranquilla', 'pereira', 'valledupar', 'bucaramanga', 'cartagena', 'manizales', 'armenia', 'ibague', 'ibagué', 'dosquebradas'];
var NOMBRE_CIUDAD_CANONICO_REPISA = {
  medellin: 'Medellín', 'medellín': 'Medellín', envigado: 'Envigado', sabaneta: 'Sabaneta',
  itagui: 'Itagüí', 'itagüí': 'Itagüí', bello: 'Bello', 'la estrella': 'La Estrella',
  caldas: 'Caldas', copacabana: 'Copacabana', girardota: 'Girardota',
  bogota: 'Bogotá', 'bogotá': 'Bogotá', cali: 'Cali', barranquilla: 'Barranquilla',
  pereira: 'Pereira', valledupar: 'Valledupar', bucaramanga: 'Bucaramanga',
  cartagena: 'Cartagena', manizales: 'Manizales', armenia: 'Armenia',
  ibague: 'Ibagué', 'ibagué': 'Ibagué', dosquebradas: 'Dosquebradas'
};

function extraerTextosUsuarioRepisa(mensajeActual, historialReciente) {
  var textos = (Array.isArray(historialReciente) ? historialReciente : [])
    .filter(function(m) { return m && m.role === 'user' && typeof m.content === 'string'; })
    .map(function(m) { return m.content; });
  textos.push(mensajeActual || '');
  return textos;
}

function detectarCiudadEnTextoRepisa(texto) {
  var textoLower = (texto || '').toLowerCase();
  for (var i = 0; i < CIUDADES_AREA_METRO_MEDELLIN_REPISA.length; i++) {
    if (textoLower.indexOf(CIUDADES_AREA_METRO_MEDELLIN_REPISA[i]) !== -1) {
      return { ciudad: NOMBRE_CIUDAD_CANONICO_REPISA[CIUDADES_AREA_METRO_MEDELLIN_REPISA[i]], modalidad: 'instalado_medellin' };
    }
  }
  for (var j = 0; j < CIUDADES_RECONOCIDAS_ENVIO_REPISA.length; j++) {
    if (textoLower.indexOf(CIUDADES_RECONOCIDAS_ENVIO_REPISA[j]) !== -1) {
      return { ciudad: NOMBRE_CIUDAD_CANONICO_REPISA[CIUDADES_RECONOCIDAS_ENVIO_REPISA[j]], modalidad: 'envio_nacional' };
    }
  }
  return null;
}

function detectarCotizacionRepisaDesdeContexto(params) {
  params = params || {};
  var textosUsuario = extraerTextosUsuarioRepisa(params.mensajeActual, params.historialReciente);
  var textoCombinado = textosUsuario.join(' \n ');

  // Cualquier señal de caso especial en CUALQUIER mensaje reciente bloquea
  // la detección — más vale escalar de más que cotizar un caso que en
  // realidad necesitaba revisión (entamborada, espesor, etc.).
  if (REGEX_ESPESOR_ESPECIAL_REPISA.test(textoCombinado)) return null;

  // Medida: busca desde el mensaje MÁS RECIENTE hacia atrás — si el
  // cliente corrigió la medida en un mensaje posterior, esa es la válida.
  var largoCm = null, profundidadCm = null;
  for (var i = textosUsuario.length - 1; i >= 0; i--) {
    var m = textosUsuario[i].match(REGEX_MEDIDA_REPISA);
    if (m) {
      largoCm = Number(m[1]);
      profundidadCm = Number(m[2]);
      break;
    }
  }
  if (largoCm === null || profundidadCm === null) return null;

  // Ciudad: prioriza el mensaje actual (lo normal es que llegue como
  // respuesta a la pregunta de Olivia); si no, la busca hacia atrás.
  var infoCiudad = detectarCiudadEnTextoRepisa(params.mensajeActual);
  if (!infoCiudad) {
    for (var k = textosUsuario.length - 2; k >= 0; k--) {
      infoCiudad = detectarCiudadEnTextoRepisa(textosUsuario[k]);
      if (infoCiudad) break;
    }
  }
  if (!infoCiudad) return null;

  // Mismos límites seguros que la fórmula (Fase 6) — sin duplicar la
  // regla, reutiliza las constantes ya definidas arriba.
  if (PROFUNDIDADES_ELEGIBLES_FORMULA_REPISA.indexOf(profundidadCm) === -1) return null;
  if (largoCm < LARGO_MIN_FORMULA_REPISA || largoCm > LARGO_MAX_FORMULA_REPISA) return null;

  return {
    largoCm: largoCm,
    profundidadCm: profundidadCm,
    cantidad: 1,
    ciudad: infoCiudad.ciudad,
    modalidad: infoCiudad.modalidad,
    fuente: 'contexto_reciente'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 COTIZADOR V2 REPISAS (26 jul) — resolución determinística de precio en
// JS puro. Claude NUNCA calcula ni interpola aritmética (esa regla se
// mantiene sin cambios) — recibe el precio ya resuelto por esta función.
// Pura y testeable: no toca la BD ni módulo, recibe el catálogo como
// parámetro. Ver test/cotizador-v2.test.js para los casos cubiertos.
//
// Reglas acordadas con Lili:
// - Modalidad "recoge" (Modo 3): siempre requiere_aprobacion (sin CSV de
//   desglose de transporte/buffer para calcularlo automáticamente).
// - Coincidencia exacta (profundidad+largo) → tipoResolucion "exacto",
//   tiene PRIORIDAD sobre la fórmula (fila validada manualmente).
// - 🆕 FASE 6 (27 jul) — sin exacta: YA NO interpola. Calcula por fórmula
//   real (calcularPrecioRepisaDesdeFormula) si la combinación cae dentro
//   de límites seguros (ver elegibleParaFormulaRepisa) — si no, escala.
//   Decisión explícita de Lili: nada de "adivinar" entre dos referencias
//   vecinas — o hay dato exacto, o se calcula real, o se escala.
// - permiteDescuentoAutomatico solo puede ser true en coincidencia EXACTA
//   con requiere_aprobacion_descuento = false en esa fila — un precio
//   calculado por fórmula nunca habilita descuento automático (más
//   conservador, igual que la interpolación antes).
// ═══════════════════════════════════════════════════════════════════════════
function resolverPrecioRepisa(params, catalogoRepisas) {
  params = params || {};
  var largoCm = params.largoCm;
  var profundidadCm = params.profundidadCm;

  var resultado = {
    tipoResolucion: 'requiere_aprobacion',
    largoSolicitado: largoCm,
    profundidadSolicitada: profundidadCm,
    referenciaInferior: null,
    referenciaSuperior: null,
    precioBase: null,
    precioMinimoAprobado: null,
    valorTecnico: null,
    precioFinalSugerido: null,
    permiteDescuentoAutomatico: false,
    alerta: null,
    // 🆕 FASE 6 — solo se llena cuando hay un mensaje específico para el
    // cliente distinto al genérico de escalarCotizacionSinPrecio (hoy:
    // únicamente profundidad>30cm, ver más abajo).
    mensajeParaCliente: null,
    // 🆕 FASE 6 — desglose completo cuando tipoResolucion === 'formula',
    // para poder auditar/loguear cada componente del cálculo.
    desgloseFormula: null
  };

  if (params.modalidad && params.modalidad !== 'instalado' && params.modalidad !== 'enviado') {
    resultado.alerta = 'Modalidad "recoge cliente" — siempre requiere aprobación manual de Lili.';
    return resultado;
  }
  var modalidad = params.modalidad === 'enviado' ? 'enviado' : 'instalado';

  if (typeof largoCm !== 'number' || isNaN(largoCm) || typeof profundidadCm !== 'number' || isNaN(profundidadCm) || !Array.isArray(catalogoRepisas)) {
    resultado.alerta = 'Datos insuficientes para resolver el precio.';
    return resultado;
  }

  var campoComercial = modalidad === 'enviado' ? 'comercial_enviado' : 'comercial_instalado';
  var campoTecnico = modalidad === 'enviado' ? 'tecnico_enviado' : 'tecnico_instalado';

  var filasProfundidad = catalogoRepisas.filter(function(f) { return f.prof_cm === profundidadCm; });

  var exacta = filasProfundidad.find(function(f) { return f.largo_cm === largoCm; });
  if (exacta) {
    resultado.tipoResolucion = 'exacto';
    resultado.referenciaInferior = exacta;
    resultado.referenciaSuperior = exacta;
    resultado.precioBase = exacta[campoComercial];
    resultado.precioMinimoAprobado = exacta.precio_minimo_aprobado;
    resultado.valorTecnico = exacta[campoTecnico];
    resultado.precioFinalSugerido = exacta[campoComercial];
    resultado.permiteDescuentoAutomatico = !exacta.requiere_aprobacion_descuento;
    resultado.alerta = exacta.alerta || null;
    return resultado;
  }

  // 🆕 FASE 6 (27 jul) — sin fila exacta, YA NO se interpola. Guarda
  // específica primero: profundidad>30cm no es solo "fuera de rango", es
  // un cambio real de sistema de instalación (soportes invisibles dejan
  // de servir, se necesitan listones con pared de fondo + pared lateral)
  // — el cliente necesita un mensaje distinto al genérico, no solo "es
  // más personalizada". Se evalúa independiente de la modalidad: es una
  // restricción del producto, no de quién instala.
  if (profundidadCm > 30) {
    resultado.alerta = 'Profundidad mayor a 30cm — ya no aplican soportes invisibles, requiere evaluar instalación con listones (necesita pared de fondo + pared lateral disponible). Validar con Lili.';
    resultado.mensajeParaCliente = 'Para esa profundidad ya no usamos soportes invisibles, sino instalación con listones — necesito confirmar con Lili el tipo de pared antes de darte el valor exacto 😊';
    return resultado;
  }

  if (elegibleParaFormulaRepisa(largoCm, profundidadCm, modalidad)) {
    var calculo = calcularPrecioRepisaDesdeFormula(largoCm, profundidadCm);
    resultado.tipoResolucion = 'formula';
    resultado.precioBase = calculo.precioComercial;
    resultado.valorTecnico = calculo.valorTecnico;
    resultado.precioFinalSugerido = calculo.precioComercial;
    resultado.permiteDescuentoAutomatico = false;
    resultado.desgloseFormula = calculo;
    resultado.alerta = null;
    return resultado;
  }

  resultado.alerta = 'Sin fila exacta y fuera de las condiciones seguras para calcular por fórmula (profundidad no modelada, largo fuera de ' +
    LARGO_MIN_FORMULA_REPISA + '-' + LARGO_MAX_FORMULA_REPISA + 'cm, o modalidad distinta a instalado) — requiere aprobación manual.';
  return resultado;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 COTIZADOR V2 REPISAS — FASE 3 de integración (26 jul, aprobada por Lili
// en pasos: 1-preparación, 2-mapeo de flujo, 3-parser). Parser puro del tag
// interno `[COTIZAR_REPISA:...]` que Claude emitirá cuando tenga datos
// suficientes para cotizar una repisa — ver docs/COTIZADOR_V2_PLAN.md.
// Todavía NO conectado a procesarMensaje() ni al webhook (eso es la
// integración completa, fase posterior) — esto es solo el parser,
// aislado y probado.
//
// Nunca calcula nada — solo extrae y valida la estructura del tag;
// resolverPrecioRepisa() sigue siendo la única función que calcula precios.
//
// Decisión de negocio (26 jul): cantidad > 1 SIEMPRE escala a Lili — ya
// existen reglas de descuento por volumen aprobadas que NO están
// implementadas todavía (ver docs/PENDIENTES.md, Fase C futura:
// calcularDescuentoPorVolumen()). Multiplicar el precio unitario directo
// ignoraría esas reglas y podría cobrar de más. Por diseño, el prompt de
// Claude deberá instruir no emitir el tag si cantidad > 1 (fase de
// integración con el prompt, todavía no implementada) — este parser lo
// señala explícitamente vía `elegibleParaCalculoAutomatico` como defensa
// adicional, por si el modelo no sigue esa instrucción.
// ═══════════════════════════════════════════════════════════════════════════
const MAPA_MODALIDAD_TAG_A_FUNCION = {
  instalado_medellin: 'instalado',
  envio_nacional: 'enviado'
  // 'recogida' se deja tal cual — resolverPrecioRepisa() ya la trata como
  // modalidad no reconocida (Modo 3) y devuelve requiere_aprobacion, sin
  // necesidad de traducción.
};

function extraerTagCotizarRepisa(textoRespuesta) {
  if (typeof textoRespuesta !== 'string') return null;
  var match = textoRespuesta.match(/\[COTIZAR_REPISA:([^\]]*)\]/);
  if (!match) return null;

  var crudo = {};
  match[1].split(',').forEach(function(par) {
    var idx = par.indexOf('=');
    if (idx === -1) return;
    crudo[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
  });

  var largoCm = Number(crudo.largo);
  var profundidadCm = Number(crudo.prof);
  var cantidadCruda = crudo.cantidad !== undefined ? Number(crudo.cantidad) : 1;

  // Tag mal formado (largo/prof ausentes o no numéricos) — no hay datos
  // suficientes para intentar nada, se trata como si no hubiera tag válido.
  if (isNaN(largoCm) || isNaN(profundidadCm) || largoCm <= 0 || profundidadCm <= 0) return null;

  var cantidad = (isNaN(cantidadCruda) || cantidadCruda < 1) ? 1 : cantidadCruda;
  var modalidadTag = crudo.modalidad || null;
  var modalidadParaResolver = (modalidadTag && MAPA_MODALIDAD_TAG_A_FUNCION[modalidadTag])
    ? MAPA_MODALIDAD_TAG_A_FUNCION[modalidadTag]
    : modalidadTag;

  return {
    tagEncontrado: true,
    largoCm: largoCm,
    profundidadCm: profundidadCm,
    cantidad: cantidad,
    ciudad: crudo.ciudad || null,
    modalidadTag: modalidadTag,
    modalidadParaResolver: modalidadParaResolver,
    // Decisión de negocio: solo cantidad === 1 puede usar el cálculo
    // automático de resolverPrecioRepisa(); cantidad > 1 siempre escala.
    elegibleParaCalculoAutomatico: cantidad === 1
  };
}

// Quita el tag del texto crudo de Claude. Uso previsto en la integración
// completa (fase posterior): el tag nunca debe llegar visible al cliente.
function quitarTagCotizarRepisa(textoRespuesta) {
  if (typeof textoRespuesta !== 'string') return textoRespuesta;
  return textoRespuesta.replace(/\[COTIZAR_REPISA:[^\]]*\]/g, '').trim();
}

async function crearIndices() {
  var indices = [
    { nombre: 'idx_conversaciones_numero', sql: 'CREATE INDEX IF NOT EXISTS idx_conversaciones_numero ON conversaciones(numero)' },
    { nombre: 'idx_seguimientos_numero',   sql: 'CREATE INDEX IF NOT EXISTS idx_seguimientos_numero ON seguimientos(numero)' },
    { nombre: 'idx_pausados_numero',       sql: 'CREATE INDEX IF NOT EXISTS idx_pausados_numero ON pausados(numero)' },
    { nombre: 'idx_notas_numero',          sql: 'CREATE INDEX IF NOT EXISTS idx_notas_numero ON notas(numero)' },
    // 🆕 FASE 1A — índices de las tablas nuevas del CRM
    { nombre: 'idx_messages_lead_id',      sql: 'CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)' },
    { nombre: 'idx_lead_events_lead_id',    sql: 'CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id ON lead_events(lead_id)' },
    { nombre: 'idx_lead_events_event_type', sql: 'CREATE INDEX IF NOT EXISTS idx_lead_events_event_type ON lead_events(event_type)' },
    { nombre: 'idx_lead_events_created_at', sql: 'CREATE INDEX IF NOT EXISTS idx_lead_events_created_at ON lead_events(created_at)' },
    // 🆕 FASE 1A, PASO 7 — índices de lead_form_submissions
    { nombre: 'idx_lead_form_submissions_lead_id', sql: 'CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_lead_id ON lead_form_submissions(lead_id)' },
    { nombre: 'idx_lead_form_submissions_estado',  sql: 'CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_estado ON lead_form_submissions(estado_vinculacion)' }
  ];

  for (var i = 0; i < indices.length; i++) {
    try {
      await pool.query(indices[i].sql);
      console.log('Índice listo: ' + indices[i].nombre);
    } catch (e) {
      console.error('Error creando índice ' + indices[i].nombre + ':', e.message);
    }
  }
}

async function inicializarBD() {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS conversaciones (numero TEXT PRIMARY KEY, mensajes JSONB NOT NULL DEFAULT \'[]\')');
    await pool.query('CREATE TABLE IF NOT EXISTS pausados (numero TEXT PRIMARY KEY)');
    await pool.query('CREATE TABLE IF NOT EXISTS seguimientos (numero TEXT PRIMARY KEY, estado TEXT NOT NULL, timestamp BIGINT NOT NULL, intentos INT NOT NULL DEFAULT 0, ultimo_mensaje_lead BIGINT)');
    // 🆕 Seguimiento consciente del producto (auditoría 2 ago 2026): antes
    // TODOS los seguimientos decían "repisa" sin importar qué producto pidió
    // el lead. Ver getMensajeSeguimiento()/mensajeReactivacion() más abajo.
    await pool.query('ALTER TABLE seguimientos ADD COLUMN IF NOT EXISTS producto TEXT');
    // 🆕 Etapa 2, punto 2 (3 ago 2026) — cadencia de seguimiento según la
    // intención de compra que el lead marcó en el formulario. Ver
    // detectarIntencionCompraFormulario() y VENTANA_REACTIVACION_POR_INTENCION.
    await pool.query('ALTER TABLE seguimientos ADD COLUMN IF NOT EXISTS nivel_intencion TEXT');
    await pool.query('CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT)');
    await pool.query('CREATE TABLE IF NOT EXISTS notas (numero TEXT PRIMARY KEY, nota TEXT)');

    // ═══════════════════════════════════════════════════════════════════
    // 🆕 FASE 1A (22 jul): tablas nuevas del CRM (leads, messages,
    // lead_events). Conviven en paralelo con las tablas legacy de arriba
    // — no las reemplazan ni les quitan lectura/escritura todavía. Ver
    // docs/PHASE_1A_ROLLBACK.md para el procedimiento de reversión.
    // ═══════════════════════════════════════════════════════════════════
    await pool.query(
      'CREATE TABLE IF NOT EXISTS leads (' +
      'id SERIAL PRIMARY KEY, ' +
      'whatsapp_phone TEXT UNIQUE NOT NULL, ' +
      'display_name TEXT, ' +
      'source TEXT, ' +
      'product TEXT, ' +
      'city TEXT, ' +
      "owner TEXT NOT NULL DEFAULT 'OLIVIA', " +
      'olivia_enabled BOOLEAN NOT NULL DEFAULT true, ' +
      "lifecycle_stage TEXT NOT NULL DEFAULT 'NEW', " +
      'lead_temperature TEXT, ' +
      'qualification_status TEXT, ' +
      'campaign_id TEXT, ' +
      'campaign_name TEXT, ' +
      'adset_id TEXT, ' +
      'adset_name TEXT, ' +
      'ad_id TEXT, ' +
      'ad_name TEXT, ' +
      'form_id TEXT, ' +
      'form_name TEXT, ' +
      "referral_data JSONB NOT NULL DEFAULT '{}', " +
      "lead_form_data JSONB NOT NULL DEFAULT '{}', " +
      'first_contact_at TIMESTAMPTZ, ' +
      'last_customer_message_at TIMESTAMPTZ, ' +
      'last_business_message_at TIMESTAMPTZ, ' +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
      ')'
    );
    // 🆕 Etapa 2, punto 2 (3 ago 2026) — intención de compra declarada en el
    // formulario ("¿cuándo_te_gustaría_comprarla?"), persistida en el lead
    // para sobrevivir hasta que se active el primer saludo_sin_respuesta.
    await pool.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS buy_intent TEXT');

    await pool.query(
      'CREATE TABLE IF NOT EXISTS messages (' +
      'id BIGSERIAL PRIMARY KEY, ' +
      'lead_id INTEGER NOT NULL REFERENCES leads(id), ' +
      'whatsapp_message_id TEXT UNIQUE, ' +
      'direction TEXT NOT NULL, ' +
      'sender_type TEXT NOT NULL, ' +
      'message_type TEXT, ' +
      'text_content TEXT, ' +
      'media_id TEXT, ' +
      "raw_payload JSONB NOT NULL DEFAULT '{}', " +
      'occurred_at TIMESTAMPTZ, ' +
      'received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
      ')'
    );

    await pool.query(
      'CREATE TABLE IF NOT EXISTS lead_events (' +
      'id BIGSERIAL PRIMARY KEY, ' +
      // lead_id es NULLABLE a propósito (desde el Paso 7): un evento leadgen
      // puede llegar y necesitar quedar registrado (LEAD_FORM_WEBHOOK_RECEIVED,
      // LEAD_FORM_DATA_RETRIEVED) ANTES de que exista o se pueda vincular un
      // lead de WhatsApp. Ver lead_form_submissions más abajo.
      'lead_id INTEGER REFERENCES leads(id), ' +
      'event_type TEXT NOT NULL, ' +
      'actor TEXT, ' +
      'source TEXT, ' +
      "metadata JSONB NOT NULL DEFAULT '{}', " +
      'whatsapp_message_id TEXT, ' +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
      ')'
    );
    // Defensivo/idempotente: por si esta tabla ya se hubiera creado antes con
    // NOT NULL en una ejecución previa de esta misma rama de desarrollo.
    await pool.query('ALTER TABLE lead_events ALTER COLUMN lead_id DROP NOT NULL');

    // ═══════════════════════════════════════════════════════════════════
    // 🆕 FASE 1A, PASO 7 (22 jul) — lead_form_submissions.
    // Tabla NUEVA, no prevista en el esquema original del Paso 3. Necesaria
    // porque un evento leadgen de Meta Lead Ads NO trae un número de
    // WhatsApp — solo `leadgen_id`, `form_id`, `ad_id`, `page_id`. Hasta que
    // se pueda vincular con un lead real (por teléfono, si el formulario lo
    // pide), el registro vive aquí como "lead externo pendiente de
    // vinculación", tal como pide la sección 7 del prompt de Fase 1A.
    //
    // 🔄 ACTUALIZACIÓN (22 jul 2026): Lili confirmó que ya activó la
    // suscripción al campo de webhook `leadgen` en el Meta App Dashboard
    // ("Se suscribió correctamente al campo del webhook leadgen v25.0").
    // Con esto, el evento YA PUEDE llegar a este endpoint. Sigue habiendo
    // dos cosas sin verificar antes de dar esto por completamente activo
    // — ver el banner grande junto a manejarEventoLeadgen() para el detalle
    // y los pasos exactos a confirmar antes de generar un lead de prueba.
    // ═══════════════════════════════════════════════════════════════════
    await pool.query(
      'CREATE TABLE IF NOT EXISTS lead_form_submissions (' +
      'id SERIAL PRIMARY KEY, ' +
      'leadgen_id TEXT UNIQUE NOT NULL, ' +
      'page_id TEXT, ' +
      'form_id TEXT, ' +
      'ad_id TEXT, ' +
      'adgroup_id TEXT, ' +
      "field_data JSONB NOT NULL DEFAULT '[]', " +
      'lead_id INTEGER REFERENCES leads(id), ' +
      "estado_vinculacion TEXT NOT NULL DEFAULT 'PENDIENTE', " +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
      ')'
    );

    // ═══════════════════════════════════════════════════════════════════
    // 🆕 COTIZADOR V2 REPISAS (26 jul) — reemplaza la tabla de precios de
    // repisas que vivía como texto fijo dentro de getSystemPrompt(). Datos
    // reales de costos/técnico/comercial por profundidad+largo, sembrados
    // desde data/precios_repisas_v2.csv. Ver sembrarPreciosRepisas() más
    // abajo (fuera de inicializarBD, se llama después de crear la tabla).
    // ═══════════════════════════════════════════════════════════════════
    await pool.query(
      'CREATE TABLE IF NOT EXISTS precios_repisas (' +
      'id SERIAL PRIMARY KEY, ' +
      'prof_cm INTEGER NOT NULL, ' +
      'largo_cm INTEGER NOT NULL, ' +
      'costo_real_instalado INTEGER NOT NULL, ' +
      'tecnico_instalado INTEGER NOT NULL, ' +
      'comercial_instalado INTEGER NOT NULL, ' +
      'costo_real_enviado INTEGER NOT NULL, ' +
      'tecnico_enviado INTEGER NOT NULL, ' +
      'comercial_enviado INTEGER NOT NULL, ' +
      'envio_real_estimado INTEGER NOT NULL, ' +
      'precio_minimo_aprobado INTEGER NOT NULL, ' +
      "alerta TEXT NOT NULL DEFAULT '', " +
      'requiere_aprobacion_descuento BOOLEAN NOT NULL DEFAULT false, ' +
      'UNIQUE(prof_cm, largo_cm)' +
      ')'
    );
    await sembrarPreciosRepisas();

    await crearIndices();

    var rc = await pool.query('SELECT numero, mensajes FROM conversaciones');
    var baseT = Date.now();
    rc.rows.forEach(function(row, idx) {
      conversaciones[row.numero] = row.mensajes || [];
      ultimaActividad[row.numero] = baseT - (rc.rows.length - idx) * 1000;
    });

    var rp = await pool.query('SELECT numero FROM pausados');
    rp.rows.forEach(function(row) { pausados[row.numero] = true; });

    var rs = await pool.query('SELECT numero, estado, timestamp, intentos, ultimo_mensaje_lead, producto, nivel_intencion FROM seguimientos');
    rs.rows.forEach(function(row) {
      seguimientos[row.numero] = {
        estado: row.estado,
        timestamp: Number(row.timestamp),
        intentos: row.intentos,
        ultimoMensajeLead: row.ultimo_mensaje_lead ? Number(row.ultimo_mensaje_lead) : undefined,
        producto: row.producto || null,
        nivelIntencion: row.nivel_intencion || null
      };
    });

    var ra = await pool.query("SELECT valor FROM ajustes WHERE clave = 'pausadoTodo'");
    if (ra.rows.length > 0) pausadoTodo = ra.rows[0].valor === 'true';

    var rn = await pool.query('SELECT numero, nota FROM notas');
    rn.rows.forEach(function(row) { if (row.nota) notas[row.numero] = row.nota; });

    // ═══════════════════════════════════════════════════════════════════
    // 🧹 LIMPIEZA (24 jun): el número personal de Lili NUNCA debe quedar
    // registrado en seguimientos ni en pausados. Las protecciones en
    // activarSeguimiento() y marcarPausado() evitan que se cree un registro
    // NUEVO, pero si ya existía uno ANTES de esas protecciones (guardado en
    // Postgres), seguía ahí y los cronjobs de seguimiento/reactivación lo
    // seguían procesando. Esta limpieza corre una sola vez en cada arranque
    // del servidor y borra cualquier rastro viejo, en memoria y en la BD.
    // Es seguro ejecutarla siempre, incluso si no hay nada que borrar.
    // ═══════════════════════════════════════════════════════════════════
    if (LILI_NUMERO) {
      delete seguimientos[LILI_NUMERO];
      delete pausados[LILI_NUMERO];
      await pool.query('DELETE FROM seguimientos WHERE numero = $1', [LILI_NUMERO]);
      await pool.query('DELETE FROM pausados WHERE numero = $1', [LILI_NUMERO]);
      console.log('🧹 Limpieza de arranque: LILI_NUMERO (' + LILI_NUMERO + ') removido de seguimientos y pausados, si existía');
    }

    bdLista = true;
    verificarModoCampana(); // Log en arranque para confirmar qué modo está activo
    console.log('BD lista: ' + rc.rows.length + ' conversaciones, ' + rp.rows.length + ' pausados, ' + rs.rows.length + ' seguimientos');
  } catch (e) {
    console.error('Error inicializando BD:', e.message);
  }
}

function guardarConversacion(numero) {
  ultimaActividad[numero] = Date.now();
  var msgs = conversaciones[numero] || [];
  pool.query(
    'INSERT INTO conversaciones (numero, mensajes) VALUES ($1, $2) ON CONFLICT (numero) DO UPDATE SET mensajes = $2',
    [numero, JSON.stringify(msgs)]
  ).catch(function(e) { console.error('Error guardando conversacion ' + numero + ':', e.message); });
}

function marcarPausado(numero) {
  // PROTECCIÓN: el número de Lili NUNCA debe pausarse por el sistema automático
  // (ni por escalado, ni por marcar estado, ni por nada). Si el código intenta
  // pausar a Lili, simplemente se ignora.
  if (numero === LILI_NUMERO) return;
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
    'INSERT INTO seguimientos (numero, estado, timestamp, intentos, ultimo_mensaje_lead, producto, nivel_intencion) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (numero) DO UPDATE SET estado = $2, timestamp = $3, intentos = $4, ultimo_mensaje_lead = $5, producto = $6, nivel_intencion = $7',
    [numero, s.estado, s.timestamp, s.intentos, s.ultimoMensajeLead || null, s.producto || null, s.nivelIntencion || null]
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

// Borra TODO el rastro de un número: conversación, pausa, seguimiento y nota.
// Pensado para que Lili pueda resetear su propia conversación de prueba y volver
// a ver el flujo completo (saludo + fotos) cuando ensaya cambios en Olivia.
function borrarHistorialCompleto(numero) {
  delete conversaciones[numero];
  delete pausados[numero];
  delete seguimientos[numero];
  delete notas[numero];
  delete ultimaActividad[numero];

  return Promise.all([
    pool.query('DELETE FROM conversaciones WHERE numero = $1', [numero]),
    pool.query('DELETE FROM pausados WHERE numero = $1', [numero]),
    pool.query('DELETE FROM seguimientos WHERE numero = $1', [numero]),
    pool.query('DELETE FROM notas WHERE numero = $1', [numero])
  ]).catch(function(e) { console.error('Error borrando historial de ' + numero + ':', e.message); });
}

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

// 🆕 Seguimiento consciente del producto (auditoría 2 ago 2026) — antes
// TODOS los mensajes de seguimiento decían "repisa" sin importar qué
// producto pidió el lead, porque nacieron cuando Repisa Flotante era el
// único producto. Mapa de artículo/nombre/pronombre/concordancia para poder
// generar frases gramaticalmente correctas para cualquier producto sin
// reescribir cada mensaje a mano. Nunca se usa "repisa" como fallback — el
// `default` (producto null/desconocido) usa "tu pedido", nunca un producto
// específico adivinado.
var INFO_PRODUCTO_SEGUIMIENTO_DEFAULT = { articulo: 'el', nombre: 'pedido', pron: 'lo', listo: 'listo' };
var INFO_PRODUCTO_SEGUIMIENTO = {
  'Repisa Flotante': { articulo: 'la', nombre: 'repisa', pron: 'la', listo: 'lista' },
  'Mesa Auxiliar': { articulo: 'la', nombre: 'mesa auxiliar', pron: 'la', listo: 'lista' },
  'Escritorio Flotante': { articulo: 'el', nombre: 'escritorio', pron: 'lo', listo: 'listo' },
  'Escritorio con Cajones': { articulo: 'el', nombre: 'escritorio', pron: 'lo', listo: 'listo' }
};

function infoProductoSeguimiento(producto) {
  return INFO_PRODUCTO_SEGUIMIENTO[producto] || INFO_PRODUCTO_SEGUIMIENTO_DEFAULT;
}

function getMensajeSeguimiento(estado, intento, nombre, producto) {
  var n = nombre ? nombre : '';
  var saludo = n ? ('Hola ' + n + '! 😊') : 'Hola! 😊';
  var info = infoProductoSeguimiento(producto);

  if (estado === 'saludo_sin_respuesta') {
    if (intento === 1) return saludo + ' ¿Pudiste pensar en ' + info.articulo + ' ' + info.nombre + '? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿';
    if (intento === 2) return saludo + ' Aquí estoy cuando quieras retomar 🌿';
  }
  if (estado === 'esperando_info') {
    if (intento === 1) return saludo + ' Solo quería saber si pudiste tomar las medidas del espacio. Cuando las tengas me avisas y te preparo todo 🌿';
    if (intento === 2) return saludo + ' Aquí estoy cuando quieras retomar 🌿';
  }
  if (estado === 'esperando_decision') {
    if (intento === 1) return saludo + ' ¿Alcanzaste a ver el espacio donde ' + info.pron + ' quieres? Tengo cupo de fabricación esta semana si quieres que te ' + info.pron + ' deje ' + info.listo + ' 🌿';
    if (intento === 2) return saludo + ' Solo para no dejarte ' + info.articulo + ' ' + info.nombre + ' pendiente — si más adelante ' + info.pron + ' quieres retomar, aquí estoy con mucho gusto 😊';
  }
  if (estado === 'cotizacion_enviada') {
    if (intento === 1) return saludo + ' ¿Cómo te fue con la cotización de tu ' + info.nombre + '? Si quieres ajustamos cualquier detalle (medida, fecha de entrega). Tengo cupo para arrancar esta semana 🌿';
    if (intento === 2) return saludo + ' Solo para no dejarte ' + info.articulo + ' ' + info.nombre + ' pendiente — si más adelante ' + info.pron + ' quieres retomar, aquí estoy con mucho gusto 😊';
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

// 🆕 Deduplicación determinística de formulario repetido (auditoría 2 ago
// 2026, caso real Deissy): un reenvío técnico del mismo texto (mismo
// número, mismo contenido) hacía que Olivia lo tratara como mensaje nuevo y
// repitiera el saludo. Compara SOLO contra el último mensaje 'user' guardado
// (no contra todo el historial) — si el texto es idéntico Y ya hay una
// respuesta 'assistant' después de ese mensaje anterior, es un reenvío ya
// respondido. `historial` debe incluir el mensaje actual como último
// elemento (agregarMensaje() ya lo agregó antes de llamar a
// procesarMensaje()) — se busca hacia atrás SIN contarlo.
function detectarMensajeDuplicado(historial, textoActual) {
  if (!Array.isArray(historial) || historial.length < 2) return false;
  for (var i = historial.length - 2; i >= 0; i--) {
    var entrada = historial[i];
    if (!entrada || entrada.role !== 'user') continue;
    if (entrada.content !== textoActual) return false; // el 'user' anterior más reciente no coincide — no es reenvío
    for (var j = i + 1; j < historial.length - 1; j++) {
      if (historial[j] && historial[j].role === 'assistant') return true; // ya se había respondido a ese mensaje
    }
    return false; // texto igual pero todavía sin respuesta previa — no es un reenvío real
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 FIX (24 jun): activarSeguimiento ahora protege LILI_NUMERO.
// Antes, cuando un lead escalaba y el mensaje de Lili (desde su número
// personal) pasaba por el flujo de "mensaje saliente" o por cualquier otro
// camino que llamara activarSeguimiento() con su propio número, Lili quedaba
// registrada como si fuera un lead. Los cronjobs de seguimiento/reactivación
// (que corren cada hora) entonces intentaban mandarle mensajes de seguimiento
// a su número personal — y como ese número no tiene la ventana de 24h abierta
// con la plantilla correcta, Meta rechazaba el envío, lo cual disparaba
// notificarLili() en bucle (ver el fix de notificarLili más abajo).
// Esta única protección corta el problema de raíz: el número de Lili nunca
// puede entrar al objeto `seguimientos`, sin importar desde dónde se llame
// esta función.
// ═══════════════════════════════════════════════════════════════════════════
function activarSeguimiento(numero, estado, producto) {
  // PROTECCIÓN: Lili NUNCA puede quedar registrada como lead en seguimiento
  if (numero === LILI_NUMERO) {
    console.log('⏹️ Ignorando activación de seguimiento para Lili (' + numero + ') — su número no es un lead');
    return;
  }

  if (seguimientos[numero] &&
      (seguimientos[numero].estado === 'cerrado_venta' ||
       seguimientos[numero].estado === 'cerrado_perdido')) return;

  // 🆕 Si quien llama no tiene el producto a mano en este momento, se
  // conserva el que ya se conocía de este número (nunca se pierde ni se
  // inventa) — null solo si nunca se supo.
  var productoResuelto = producto || (seguimientos[numero] && seguimientos[numero].producto) || null;

  seguimientos[numero] = { estado: estado, timestamp: Date.now(), intentos: 0, producto: productoResuelto };
  guardarSeguimiento(numero);
  console.log('Seguimiento activado para ' + numero + ': ' + estado + (productoResuelto ? ' (producto: ' + productoResuelto + ')' : ''));
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

// 🆕 FASE 1A, PASO 11 — igual que el guard de app.listen(): estos cronjobs
// (seguimiento cada hora y reactivación de 12pm/7pm) solo deben correr en el
// proceso real (`node whatsapp_agent.js`), nunca cuando un archivo de
// pruebas hace `require(...)`. Sin este guard, cada `require` desde una
// prueba dejaba un setInterval vivo que impedía que el proceso de Node
// terminara solo (el test runner se quedaba colgado esperando que el event
// loop se vaciara). No cambia nada del comportamiento en producción.
if (require.main === module) {
setInterval(function() {
  if (!bdLista) return;
  var ahora = Date.now();
  var numeros = Object.keys(seguimientos);

  for (var i = 0; i < numeros.length; i++) {
    var numero = numeros[i];
    var seg = seguimientos[numero];

    if (seg.estado === 'cerrado_venta' || seg.estado === 'cerrado_perdido' || seg.estado === 'cerrado_sin_respuesta') continue;
    if (seg.estado === 'saludo_sin_respuesta') continue;
    if (pausadoTodo) continue;
    // 🔧 FIX (25 jun): si Lili tiene este lead pausado (lo está manejando ella),
    // el cron automático NO debe tocarlo — antes esto se ignoraba y el cron
    // podía quitarle la pausa a mitad de una conversación que ella controlaba,
    // mandando un seguimiento automático sin que ella lo pidiera. Ahora se
    // salta por completo: no cuenta intento, no manda nada, no toca la pausa.
    // El seguimiento automático solo retoma cuando ella reactiva el agente.
    if (pausados[numero]) continue;

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
        var mensaje = getMensajeSeguimiento(seg.estado, seg.intentos, nombre, seg.producto);

        if (mensaje) {
          // 🆕 La plantilla "seguimiento_repisa" tiene el texto de repisa fijo
          // (sin variable, aprobada por Meta solo para ese producto — ver el
          // texto exacto en /panel/reabrir más abajo). Fuera de la ventana de
          // 24h, WhatsApp exige una plantilla aprobada — no existe todavía
          // una plantilla genérica para Mesa Auxiliar/Escritorio, así que no
          // se puede mandar un "mensaje genérico" de texto libre aquí. Hasta
          // que exista esa plantilla, se avisa a Lili para seguimiento manual
          // en vez de mandar el producto equivocado o fallar en silencio.
          if (!seg.producto || seg.producto === 'Repisa Flotante') {
            enviarPlantilla(numero, 'seguimiento_repisa', 'es_CO');
            seg.timestamp = Date.now();
            guardarSeguimiento(numero);
            console.log('Seguimiento (plantilla) enviado a ' + numero + ' (intento ' + seg.intentos + ', estado: ' + seg.estado + ')');
          } else {
            console.log('⏭️ Seguimiento por plantilla omitido para ' + numero + ' — producto=' + seg.producto + ', no hay plantilla de WhatsApp aprobada para ese producto fuera de la ventana de 24h');
            notificarLili(numero, 'Seguimiento automático pendiente: este lead pidió "' + seg.producto + '" y todavía no hay una plantilla de WhatsApp aprobada para eso fuera de la ventana de 24h. Escríbele tú directamente.');
            seg.timestamp = Date.now();
            guardarSeguimiento(numero);
          }
        }
      } else {
        seguimientos[numero] = { estado: 'cerrado_sin_respuesta', timestamp: Date.now(), intentos: seg.intentos };
        guardarSeguimiento(numero);
        console.log('Lead cerrado silenciosamente (sin respuesta): ' + numero);
      }
    }
  }
}, 60 * 60 * 1000);
} // cierra el guard require.main === module del cronjob de seguimiento

var ultimaTandaReactivacion = null;

// 🆕 Etapa 2, punto 2 (3 ago 2026) — cadencia de reactivación (estado
// saludo_sin_respuesta) según la intención de compra del formulario.
// Tiempos aprobados por Lili. minHoras/maxHoras se miden desde el último
// mensaje real del lead (mismo criterio que ya usaba el cron, `ref` más
// abajo). Con solo 2 corridas diarias (12pm/7pm) no se puede garantizar un
// segundo intento a una hora exacta del mismo día — la granularidad real
// de este cron es de medio día, no de horas.
//
// ⚠️ Los rangos de 'durante_este_mes' y 'en_1_o_2_meses' caen fuera de la
// ventana de 24h de WhatsApp — ahí NO se puede usar texto libre
// (enviarMensaje), solo una plantilla aprobada. Mismo guard que ya existe
// en el cron horario: usa la plantilla "seguimiento_repisa" solo si el
// producto es Repisa Flotante (ese es el único texto aprobado hoy);
// para cualquier otro producto, notifica a Lili en vez de mandar el
// producto equivocado o fallar en silencio. Ver el guard en el envío,
// más abajo.
const VENTANA_REACTIVACION_POR_INTENCION = {
  'inmediatamente':          { minHoras: 3,      maxHoras: 24 },
  'en_los_próximos_15_días': { minHoras: 3,      maxHoras: 24 },
  'durante_este_mes':        { minHoras: 48,     maxHoras: 6 * 24 },
  'en_1_o_2_meses':          { minHoras: 5 * 24, maxHoras: 20 * 24 }
};
const VENTANA_REACTIVACION_DEFAULT = VENTANA_REACTIVACION_POR_INTENCION['en_los_próximos_15_días'];

function ventanaReactivacion(nivelIntencion) {
  return VENTANA_REACTIVACION_POR_INTENCION[nivelIntencion] || VENTANA_REACTIVACION_DEFAULT;
}

function mensajeReactivacion(intento, producto) {
  var info = infoProductoSeguimiento(producto);
  if (intento === 1) return 'Hola! 😊 ¿Pudiste pensar en ' + info.articulo + ' ' + info.nombre + '? Si tienes alguna duda con la medida o el espacio, con gusto te ayudo 🌿';
  return 'Hola! 😊 No hay afán. Si en algún momento quieres retomar, aquí estoy con gusto 🌿';
}

if (require.main === module) {
setInterval(function() {
  if (!bdLista) return;
  if (!reactivacion1219Habilitada()) return;
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
    var ventana = ventanaReactivacion(seg.nivelIntencion);

    if (horasDesde >= ventana.minHoras && horasDesde <= ventana.maxHoras) {
      candidatos.push({ numero: numero, seg: seg });
    } else if (horasDesde > ventana.maxHoras) {
      seguimientos[numero] = { estado: 'cerrado_sin_respuesta', timestamp: Date.now(), intentos: seg.intentos };
      guardarSeguimiento(numero);
      console.log('Lead fuera de ventana (' + ventana.maxHoras + 'h, intención: ' + (seg.nivelIntencion || 'default') + '), cerrado: ' + numero);
    }
  }

  console.log('Tanda reactivación (' + horaColombia + 'h): ' + candidatos.length + ' leads para reactivar');

  candidatos.forEach(function(c, idx) {
    setTimeout(function() {
      if (pausados[c.numero]) return;
      c.seg.intentos++;
      if (c.seg.intentos <= 2) {
        // 🆕 Etapa 2, punto 2: con la ventana ahora parametrizada por
        // intención, 'durante_este_mes' y 'en_1_o_2_meses' SÍ pueden caer
        // fuera de las 24h de WhatsApp (su minHoras ya empieza en 48h/5
        // días) — ahí no se puede usar texto libre. Mismo guard que ya
        // existe en el cron horario: plantilla solo si el producto es
        // Repisa Flotante, si no, avisa a Lili para seguimiento manual.
        var horasDesdeEnvio = (Date.now() - (c.seg.ultimoMensajeLead || c.seg.timestamp)) / (60 * 60 * 1000);
        if (horasDesdeEnvio <= 24) {
          enviarMensaje(c.numero, mensajeReactivacion(c.seg.intentos, c.seg.producto));
          console.log('Reactivación enviada a ' + c.numero + ' (intento ' + c.seg.intentos + ')');
        } else if (!c.seg.producto || c.seg.producto === 'Repisa Flotante') {
          enviarPlantilla(c.numero, 'seguimiento_repisa', 'es_CO');
          console.log('Reactivación (plantilla, fuera de 24h) enviada a ' + c.numero + ' (intento ' + c.seg.intentos + ')');
        } else {
          console.log('⏭️ Reactivación por plantilla omitida para ' + c.numero + ' — producto=' + c.seg.producto + ', no hay plantilla aprobada para ese producto fuera de la ventana de 24h');
          notificarLili(c.numero, 'Seguimiento de reactivación pendiente: este lead pidió "' + c.seg.producto + '" y está fuera de la ventana de 24h de WhatsApp sin plantilla genérica todavía. Escríbele tú directamente.');
        }
        c.seg.timestamp = Date.now();
        guardarSeguimiento(c.numero);
      } else {
        seguimientos[c.numero] = { estado: 'cerrado_sin_respuesta', timestamp: Date.now(), intentos: c.seg.intentos };
        guardarSeguimiento(c.numero);
        console.log('Lead cerrado tras 2 reactivaciones: ' + c.numero);
      }
    }, idx * 5000);
  });

}, 60 * 60 * 1000);
} // cierra el guard require.main === module del cronjob de reactivación

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 CAMPAÑA "JULIO DE ROBLE" — 2 al 20 de julio de 2026
// Esta función determina si la campaña está activa basándose en la fecha
// actual en zona horaria Colombia (UTC-5). Después del 20 de julio a las
// 23:59 COT, todo vuelve automáticamente a los precios y saludo originales
// sin ninguna intervención manual.
// ═══════════════════════════════════════════════════════════════════════════
function esCampanaActiva() {
  // Hora actual en Colombia (UTC-5)
  var ahoraUTC = new Date();
  var ahoraColombia = new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000);
  // La campaña termina al final del 20 de julio de 2026 (Colombia)
  var finCampana = new Date('2026-07-21T05:00:00.000Z'); // 21-jul 00:00 COT = 05:00 UTC
  return ahoraUTC < finCampana;
}

// Función de verificación para pruebas — simula la fecha y muestra qué
// modo está activo. Accesible desde los logs al arrancar.
function verificarModoCampana() {
  var activa = esCampanaActiva();
  console.log('🎯 Modo campaña "Julio de Roble": ' + (activa ? 'ACTIVO — precios promocionales' : 'INACTIVO — precios normales'));
  return activa;
}

function getSystemPrompt() {
  var campana = esCampanaActiva();

  // ─── COTIZADOR V2 REPISAS — FASE 4/5, detrás de feature flag ───────────
  // Con el flag apagado (default), bloqueCotizadorV2/notaRedireccionV2Profundidad/
  // bulletProfundidadDistinta15cm quedan vacíos (o con su texto original) y el
  // prompt es idéntico al de hoy — cero cambio de comportamiento (verificado
  // por prueba).
  //
  // 🆕 AJUSTE (27 jul, primer intento) — auto-limitar bloqueCotizadorV2 a
  // profundidad≠15cm (sin reclamar "prioridad" textual) NO fue suficiente:
  // confirmado con un lead real de prueba (110×25cm) que Olivia escaló de
  // inmediato con [ESCALAR] sin nunca emitir el tag — la instrucción
  // "CUÁNDO ESCALA SIEMPRE: Piden profundidad diferente a 15cm" (más
  // arriba en el prompt en ese momento) le ganó a este bloque (más abajo).
  //
  // 🆕 AJUSTE (27 jul, segundo intento) — agregar solo una nota de
  // redirección a esa regla vieja TAMPOCO fue suficiente: un segundo lead
  // de prueba mostró la misma escalada, con Claude reproduciendo casi
  // textual el ejemplo de esa misma lista. Cambios más agresivos: (1)
  // bloqueCotizadorV2 ahora se inserta ANTES de "CUÁNDO OLIVIA CIERRA
  // SOLA"/"CUÁNDO ESCALA SIEMPRE" en vez de al final del prompt — el
  // modelo lo lee primero; (2) el bullet "profundidad diferente a 15cm"
  // se ELIMINA por completo de "CUÁNDO ESCALA SIEMPRE" con el flag
  // encendido, en vez de solo llevar una nota — ver
  // bulletProfundidadDistinta15cm. Sigue sin garantía absoluta (comportamiento
  // de modelo, no de código) — confirmar con un tercer lead de prueba real.
  var v2Activo = cotizadorRepisasV2Habilitado();

  // Redirige las reglas viejas del catálogo v1 (que viven MÁS ARRIBA en
  // este mismo prompt) hacia este bloque cuando la profundidad es
  // distinta a 15cm, en vez de dejarlas escalar de inmediato. Solo existe
  // con el flag encendido — con el flag apagado, las reglas viejas quedan
  // exactamente como estaban (cero cambio de comportamiento).
  var notaRedireccionV2Profundidad = v2Activo
    ? ' Si la profundidad es distinta a 15cm, NO apliques esta regla todavía — ya viste más arriba cómo se maneja eso (sección "COTIZADOR DE REPISAS — PROFUNDIDADES DISTINTAS A 15CM"); solo escalas si esa sección te lo indica.'
    : '';

  // 🆕 (27 jul, segundo intento) — quitar el bullet ENTERO en vez de solo
  // agregarle una nota no fue suficiente la primera vez: un lead real de
  // prueba mostró que Claude seguía reproduciendo casi textual el ejemplo
  // de escalamiento de esta misma lista ("Esa medida la fabricamos con
  // gusto... [ESCALAR]"), ignorando la nota. Con el flag encendido, este
  // bullet desaparece por completo de la lista "CUÁNDO ESCALA SIEMPRE" —
  // ya no hay ninguna frase ahí que diga "profundidad diferente a 15cm =
  // escalar" para que el modelo la reproduzca.
  var bulletProfundidadDistinta15cm = v2Activo
    ? ''
    : '- Piden profundidad diferente a 15cm (30cm, 25cm, 40cm, etc.)\n';

  // El título de la lista y la REGLA DURA también se aclaran (alcance
  // explícito: "esta tabla de 15cm") cuando el flag está encendido — pero
  // condicionado igual que todo lo demás. Con el flag apagado, quedan con
  // el texto EXACTO de siempre (sin ninguna mención a "más arriba" ni a
  // "esta tabla de 15cm", que solo tendrían sentido si bloqueCotizadorV2
  // existiera).
  var tituloEscalaSiempre = v2Activo
    ? 'CUÁNDO ESCALA SIEMPRE (aunque la medida sea conocida — TODO ESTE BLOQUE ES SOLO PARA LA TABLA DE 15CM DE PROFUNDIDAD DE ARRIBA; para profundidad distinta a 15cm, ya viste más arriba cómo se maneja, ninguna de estas líneas aplica):'
    : 'CUÁNDO ESCALA SIEMPRE (aunque la medida sea conocida):';

  var reglaDuraTexto = v2Activo
    ? '- REGLA DURA (esta tabla de 15cm): NUNCA calcules ni inventes precios fuera de ESTA TABLA DE 15CM DE PROFUNDIDAD. Si el LARGO pedido no aparece en esta tabla (a 15cm de profundidad), escala: "Esa medida la fabricamos con gusto 😊 Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]"'
    : '- REGLA DURA: NUNCA calcules ni inventes precios fuera de esta tabla. Si la medida o el caso no aparece, escala: "Esa medida la fabricamos con gusto 😊 Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]"';

  var bloqueCotizadorV2 = v2Activo ? `

COTIZADOR DE REPISAS — PROFUNDIDADES DISTINTAS A 15CM, CÁLCULO VÍA TAG INTERNO:

🔴 PRIORIDAD — LEE ESTO ANTES DE SEGUIR LEYENDO EL RESTO DEL CATÁLOGO: más abajo vas a encontrar secciones tituladas "CUÁNDO ESCALA SIEMPRE" y una regla sobre "medidas no estándar" — ESAS SECCIONES SON SOLO PARA LA TABLA DE 15CM DE PROFUNDIDAD. Si la repisa que pide el cliente tiene profundidad distinta a 15cm, esta sección (la de aquí) es la que manda, no esas otras — una profundidad distinta a 15cm NUNCA es, por sí sola, motivo para escalar de inmediato. Antes de escalar por "profundidad distinta a 15cm", primero sigue el flujo de esta sección — solo escalas si esta sección te dice explícitamente que escales (ver más abajo cuáles son esos casos).

El catálogo de arriba (precio directo, sin preguntar nada, para las 15 medidas de largo) es SOLO para la profundidad estándar de 15cm — eso sigue exactamente igual, no cambia. Este bloque se activa ÚNICAMENTE cuando la conversación se sale de esa profundidad estándar.

CASO NORMAL — el cliente da una medida (largo) sin mencionar profundidad:
Sigue el flujo de siempre: da el precio de la opción estándar de 15cm directo, sin preguntar nada antes (como ya haces). Pero además, menciona con naturalidad que existen otras profundidades (20, 25 o 30cm) por si el cliente las necesita — sin convertir esto en una pregunta obligatoria ni retrasar el precio. Ejemplo:
"Perfecto 😊 La de 80cm en roble natural, 15cm de profundidad, instalación incluida en Medellín. Queda en $260.000. También la manejamos en otras profundidades (20, 25 o 30cm) si tu espacio lo requiere — ¿esta te sirve o necesitas otra? 😊"

CASO QUE ACTIVA ESTE BLOQUE — el cliente pide explícitamente una profundidad distinta a 15cm, ya sea porque lo dijo desde el principio o porque eligió una de las que ofreciste:
Aquí SÍ tienes PROHIBIDO calcular, interpolar, estimar o redondear el precio por tu cuenta — ni siquiera usando la tabla de 15cm del catálogo de arriba (esa tabla no aplica a otras profundidades). El precio de una profundidad distinta a 15cm SIEMPRE lo calcula el sistema, nunca tú. Trátala como una candidata normal a cotizar — NO la trates como una excepción rara que hay que escalar de una vez. El sistema puede calcularla automáticamente en la mayoría de los casos.

NUNCA emitas el tag en estos casos — en vez de eso, sigue conversando con naturalidad y escala con [ESCALAR] si hace falta:
- El cliente pide un espesor distinto a 3.6cm o 3cm — por ejemplo 4.5cm, 5cm, 5.4cm, o dice "entamborada", "tipo caja" o "más gruesa". Es una técnica de fabricación distinta (repisa entamborada), que este cálculo no cubre. Responde con calidez que puedes confirmarlo con Lili, sin dar precio.
- El cliente pide una profundidad mayor a 30cm. A partir de ahí ya no se usan soportes invisibles — se necesita evaluar instalación con listones, y eso depende de si hay pared de fondo y una pared lateral disponible. No asumas que sí la hay: dile que necesitas confirmar con Lili el tipo de instalación antes de dar el valor exacto.

PASO A PASO — reúne estos 3 datos, uno a la vez si hace falta, SIN escalar mientras los reúnes:
1. Largo (cm) — si falta, pregúntalo.
2. Profundidad (cm) — si falta, pregúntalo.
3. Ciudad — si falta, pregúntala. NO escales solo porque todavía no sabes la ciudad; simplemente pregúntala como pregúntas cualquier otro dato.

🔴 MUY IMPORTANTE — CONTINUIDAD ENTRE TURNOS: los 3 datos NO tienen que venir todos en el mismo mensaje. Si el largo y la profundidad ya quedaron confirmados en un mensaje ANTERIOR de esta misma conversación, y tú ya le preguntaste la ciudad, y ahora el cliente responde SOLO con la ciudad (por ejemplo: "Medellín", "Soy de Medellín", "En Medellín", "Estoy en Medellín", "Para Medellín", "Bogotá", "Cali", "Envigado", "Sabaneta"), eso NO es una medida nueva ni un caso personalizado — es el dato final que te faltaba. Combina la medida que ya tenías (de mensajes anteriores) con esta ciudad y emite el tag DE INMEDIATO. NUNCA escales en este caso ni digas "ya le aviso a Lili" — cuando el cliente responde solo la ciudad después de que tú la preguntaste, eso completa los datos, no los complica.

Cantidad: si el cliente NO menciona cuántas repisas quiere, ASUME que es 1 — NO se lo preguntes, no es un dato que falte. Solo si el cliente dice explícitamente que quiere más de una (2, 3, etc.), ahí NUNCA emitas el tag — reconoce la cantidad con calidez, confirma que todas las piezas son iguales, y escala con [ESCALAR] sin dar ningún precio (el sistema todavía no calcula descuentos por volumen).

Apenas tengas largo, profundidad y ciudad (con cantidad=1, explícita o asumida), responde ÚNICAMENTE con este tag interno, sin ningún otro texto antes o después, en este formato EXACTO:
[COTIZAR_REPISA:largo=<numero>,prof=<numero>,cantidad=1,ciudad=<ciudad>,modalidad=<modalidad>]

<modalidad> es una de estas tres:
- instalado_medellin — el cliente está en Medellín o su área metropolitana cercana (instalación incluida). Es el valor por defecto si no queda claro que es de otra ciudad.
- envio_nacional — el cliente confirmó que está en otra ciudad (sin instalación).
- recogida — SOLO si el cliente dice explícitamente que puede recoger el pedido él mismo.

Un sistema interno calculará el precio exacto a partir de este tag y te lo entregará después para que redactes la respuesta final al cliente — tú nunca calculas, solo identificas cuándo ya tienes largo+profundidad+ciudad (con profundidad distinta a 15cm) y emites el tag. El sistema puede devolver que el caso requiere aprobación de Lili (por ejemplo profundidad intermedia no modelada, o largo fuera de rango) — en ese caso te lo indicará y ahí sí escalas, con el mensaje que te dé el sistema si trae uno específico.

Este tag es completamente interno. NUNCA lo muestres junto con otro texto, NUNCA lo menciones ni lo expliques al cliente, NUNCA digas que existe un "tag" o un "sistema de cálculo" — el cliente jamás debe ver la palabra COTIZAR_REPISA ni nada parecido.` : '';

  // ─── TABLA DE PRECIOS ───────────────────────────────────────────────────
  var tablaPrecios = campana
    ? `  40cm  → $153.000 (2 soportes)
  50cm  → $170.000 (2 soportes)
  60cm  → $175.000 (2 soportes) ← precio gancho del anuncio
  70cm  → $192.000 (2 soportes)
  80cm  → $205.000 (2 soportes)
  90cm  → $240.000 (2 soportes)
  100cm → $255.000 (2 soportes)
  110cm → $340.000 (3 soportes)
  120cm → $280.000 (3 soportes)
  130cm → $296.000 (3 soportes)
  140cm → $304.000 (3 soportes)
  150cm → $320.000 (4 soportes)
  160cm → $335.000 (4 soportes)
  180cm → $352.000 (4 soportes)
  200cm → $365.000 (4 soportes)`
    : `  40cm  → $180.000 (2 soportes)
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
  150cm → $400.000 (4 soportes)
  160cm → $420.000 (4 soportes)
  180cm → $440.000 (4 soportes)
  200cm → $460.000 (4 soportes)`;

  // ─── PRECIO ANCLA 60CM ──────────────────────────────────────────────────
  var precio60 = campana ? '$175.000' : '$220.000';

  // ─── SALUDO INICIAL ─────────────────────────────────────────────────────
  var saludoInicial = campana
    ? `"¡Hola! 👋 Gracias por escribirnos. Este mes tenemos una promoción especial — nuestras repisas flotantes en roble natural están con 20% de descuento hasta el 20 de julio. La de 60 cm, por ejemplo, está en $175.000 (instalación incluida en Medellín). ¿Qué medida necesitas o en qué espacio la quieres poner? 😊"`
    : `"¡Hola! 👋 Soy Olivia, del equipo de Hecho por Lili 🌿

Hacemos repisas flotantes en roble natural — herrajes invisibles, esquinas redondeadas, bordes suaves e instalación incluida en Medellín. La de 60cm queda en $220.000.

¿Esta medida te funciona o necesitas otra? Cuéntame el espacio y te doy el valor exacto 😊"`;

  // ─── PASO 1 DEL FLUJO DE REPISAS ────────────────────────────────────────
  var paso1Repisa = campana
    ? `PASO 1 — Saludo + ancla en 60cm + pregunta medida:
Cuando llegue cualquier lead de repisa (sin importar cómo pregunte), el sistema envía automáticamente DOS fotos del producto, y luego tú respondes SIEMPRE con este mensaje EXACTO:

"¡Hola! 👋 Gracias por escribirnos. Este mes tenemos una promoción especial — nuestras repisas flotantes en roble natural están con 20% de descuento hasta el 20 de julio. La de 60 cm, por ejemplo, está en $175.000 (instalación incluida en Medellín). ¿Qué medida necesitas o en qué espacio la quieres poner? 😊"

NUNCA menciones el uso específico (TV, baño, sala, etc.) en este primer mensaje.
NUNCA listes otras medidas en este primer mensaje.
NUNCA alargues este mensaje con más información.`
    : `PASO 1 — Saludo + ancla en 60cm + pregunta medida:
Cuando llegue cualquier lead de repisa (sin importar cómo pregunte), el sistema envía automáticamente DOS fotos del producto, y luego tú respondes SIEMPRE con este mensaje EXACTO:

"¡Hola! 👋 Soy Olivia, del equipo de Hecho por Lili 🌿

Hacemos repisas flotantes en roble natural — herrajes invisibles, esquinas redondeadas, bordes suaves e instalación incluida en Medellín. La de 60cm queda en $220.000.

¿Esta medida te funciona o necesitas otra? Cuéntame el espacio y te doy el valor exacto 😊"

NUNCA menciones el uso específico (TV, baño, sala, etc.) en este primer mensaje.
NUNCA listes otras medidas en este primer mensaje.
NUNCA alargues este mensaje con más información.`;

  // ─── PASO 2 CONFIRMACIÓN 60CM ────────────────────────────────────────────
  var paso2Repisa = campana
    ? `PASO 2 — Lead confirma la de 60cm → pre-cierre:
Si el lead dice que sí le sirve la de 60cm, responde:
"Perfecto 😊 Tu repisa de 60cm en roble macizo, lista en 5-6 días con instalación incluida en Medellín, aprovechando el precio promocional de $175.000 hasta el 20 de julio. ¿Arrancamos?"
NO pidas dirección ni datos de pago todavía.`
    : `PASO 2 — Lead confirma la de 60cm → pre-cierre:
Si el lead dice que sí le sirve la de 60cm, responde:
"Perfecto 😊 Tu repisa de 60cm en roble macizo, lista en 5-6 días con instalación incluida en Medellín. ¿Arrancamos?"
NO pidas dirección ni datos de pago todavía.`;

  // ─── REGLAS EXTRA CAMPAÑA ────────────────────────────────────────────────
  var reglasCampana = campana
    ? `
CAMPAÑA JULIO DE ROBLE — REGLAS ACTIVAS HASTA EL 20 DE JULIO:
- SIEMPRE da el precio promocional directamente, NUNCA menciones el precio original
- REGLA CRÍTICA PARA LEADS CON HISTORIAL: si en mensajes anteriores de esta conversación aparece un precio normal (por ejemplo $220.000 para 60cm), IGNÓRALO COMPLETAMENTE. Esos precios son de antes de la campaña. Siempre responde con el precio promocional actual ($175.000 para 60cm, etc.). Si el lead pregunta por qué el precio cambió, explica que tienen una promoción especial Julio de Roble activa hasta el 20 de julio.
- Si el cliente pregunta si hay descuento, confirma: "Sí, tenemos promoción Julio de Roble con 20% de descuento hasta el 20 de julio 😊"
- Si el cliente pide tiempo para decidir o dice "lo pienso", menciona con naturalidad que la promoción vence el 20 de julio. Ejemplo: "Claro que sí 😊 Cuéntame si surge alguna duda — recuerda que el precio promocional está disponible hasta el 20 de julio 🌿"
- Las repisas de 40cm y 50cm tienen 15% de descuento (no 20%) — mencionarlo SOLO si el cliente pregunta específicamente por el porcentaje de descuento
- Instalación incluida en Medellín sigue igual que siempre
- Anticipo 60% para arrancar, 40% contra entrega sigue igual que siempre
- NUNCA menciones el precio original junto al promocional ("antes valía X, ahora Y") — solo el precio actual

REGLA CRÍTICA DE CAMPAÑA — ANCLA SIEMPRE EN REPISAS:
Esta campaña de retargeting es 100% enfocada en repisas flotantes. Por eso:
- Si el lead escribe cualquier cosa genérica (saludos, preguntas sobre materiales, preguntas sobre la marca, preguntas sin mencionar un mueble específico), SIEMPRE responde con el saludo de campaña anclado en la repisa y la promo del 20 de julio — NUNCA abras el catálogo completo ni preguntes "¿qué mueble te interesa?".
- SOLO pivoteas a otro producto (escritorio, recibidor, mesa, cama) si el lead lo menciona EXPLÍCITAMENTE por nombre.
- Ejemplos de mensajes genéricos que deben anclar en repisas: "hola", "buenas", "¿cuál es el precio del roble?", "¿qué tienen?", "quiero información", "¿cómo funcionan los muebles?", "¿dónde están ubicados?" → todos van al saludo de repisas con promo.
- Ejemplo de mensaje que sí pivotea: "quiero un escritorio" → ahí sí vas al flujo de escritorio como siempre.
`
    : '';

  return `Eres Olivia, parte del equipo de Hecho por Lili, una marca de muebles artesanales en roble natural en Medellin, Colombia, fundada por la diseñadora Lili Hurtado. Acompañas a los clientes en WhatsApp: les das información, los asesoras sobre los muebles y los espacios, y cuando hace falta atención personal o algo se sale de lo que sabes, pasas la conversación a Lili.

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
- SOLO usa expresiones colombianas naturales. NUNCA uses modismos mexicanos ni de otros países. Ejemplos PROHIBIDOS (lista exacta, ninguna excepción): "te late", "órale", "chido", "wey", "padrísimo", "ahorita" (en sentido mexicano), "mande", "¿cuál te late más?", "¿qué te late?". En Colombia se dice: "listo", "con gusto", "claro que sí", "dale", "qué bueno", "¿cuál te parece?", "¿cuál te funciona?", "¿cómo te suena?"
- NUNCA uses "bacano" ni expresiones demasiado informales — el tono es cálido pero elegante
- NUNCA menciones elección de color — todas las piezas son en roble natural, no hay opciones de color
- ENVÍO DE REPISAS A OTRAS CIUDADES: SÍ se envía a otras ciudades. NO hay instalación fuera de Medellín, pero la repisa es flotante y va con sus soportes para que el cliente la instale. NUNCA digas que vas a revisar si consigues instalador — no hay instaladores fuera de Medellín. Valores de envío más abajo en la sección de repisas.

SALUDO INICIAL (SOLO primer mensaje de cada persona nueva):
Primero se envían automáticamente DOS fotos del producto (esto lo hace el sistema, no lo escribas en el mensaje).
Luego envías este texto EXACTO:

${saludoInicial}

REGLA CRÍTICA — FOTOS ADICIONALES:
- Las dos fotos automáticas del saludo son suficientes por defecto.
- NUNCA ofrezcas fotos adicionales por iniciativa propia ni preguntes si el cliente quiere ver más fotos solo porque la conversación avanza, confirma ciudad, espacio, uso o ubicación.
- Solo usa [FOTOS_EXTRA] cuando el cliente las pida explícitamente.
- Si el cliente pide un detalle específico que no está entre las fotos disponibles (otro ángulo, interior de un cajón, soportes, foto real en un espacio específico), NO uses [FOTOS_EXTRA] ni improvises con otra imagen: escala a Lili con [ESCALAR].
- NUNCA uses fotos de otro producto como sustituto.

REGLA CRÍTICA — CUANDO EL CLIENTE ENVÍA UNA IMAGEN O FOTO:
Ahora SÍ puedes ver las imágenes que el cliente manda. Cuando recibas una imagen, analízala y decide entre estos dos casos:

CASO A — Reconoces que es uno de NUESTROS productos (escritorio flotante, repisa, recibidor, mesa auxiliar, mesa de centro, cama, o cualquier mueble en roble macizo que coincida con tu catálogo):
Responde resaltando el valor del producto que identificaste (material, durabilidad, diseño) y haz UNA pregunta clave para avanzar la conversación (medida, espacio, o si quiere cotizar). Ejemplo: "¡Qué buena elección! 😊 Ese es nuestro escritorio flotante en roble macizo — duradero, con cajón de cierre suave. ¿Para qué espacio lo estás pensando?"
NO escales en este caso, sigue la conversación con naturalidad usando las reglas normales de precio y cierre.

CASO B — Es una foto de un ESPACIO (una pared, una sala, un cuarto) o de OTRO mueble que NO es de nuestro catálogo:
Reconoce con calidez lo que ves, pero escala para que Lili dé una recomendación personalizada:
"¡Qué espacio tan bonito! 😊 Para darte la recomendación perfecta para ahí, ya le aviso a Lili que lo revise. En un momentico te escribe. [ESCALAR]"

Si la imagen no es clara o no la puedes identificar con confianza, trátala como CASO B y escala.
NUNCA ignores una imagen ni respondas como si no hubiera pasado nada.
Si el mensaje del historial dice "[El cliente envió un audio]" o "[El cliente envió un archivo]" (sin ser imagen), no puedes verlo ni escucharlo — ahí sí escala siempre: "¡Gracias! 😊 Ya le aviso a Lili para que lo revise. En un momentico te escribe. [ESCALAR]"

Si el cliente comparte un link (Facebook, Instagram, cualquier URL) como texto, no puedes ver su contenido — trátalo igual que un audio o archivo: reconoce que lo recibiste, nunca describas ni asumas qué muestra, y escala con [ESCALAR]: "¡Gracias por compartir el link! 😊 Ya le aviso a Lili para que lo revise. En un momentico te escribe. [ESCALAR]"

REGLA PERMANENTE: si en cualquier momento de la conversación escalaste algo porque no podías verlo (imagen, audio, archivo, o link), NUNCA en un turno posterior afirmes con seguridad qué contenía — ni asumas que un mensaje corto del cliente ("sí", "esos", "los de la foto") confirma tu suposición sobre ese contenido. Si el cliente vuelve a referirse a algo que escalaste sin que Lili haya confirmado el contenido, sigue tratándolo como no visto.

Si ya hay mensajes previos en el historial con este número, NUNCA vuelvas a saludar como si fuera la primera vez. NUNCA digas "Hola, soy Olivia..." de nuevo.
Lee el historial, entiende en qué punto iba la conversación y continúa naturalmente desde ahí.
Ejemplos:
- Si iban hablando de una repisa de 120cm y el lead vuelve → continúa con esa conversación directamente
- Si el lead dice "ok, me decido por la de 80cm" → responde en contexto, no saludes de nuevo
- Si el lead dice "feliz día" o "hola" después de una conversación previa → responde cálido pero SIN presentarte de nuevo
El saludo inicial con presentación completa es SOLO para personas que escriben por primera vez.
Si alguien te escribe algo que NO tiene que ver con comprar o preguntar por muebles (por ejemplo: confirmar entregas, hablar de citas previas, mencionar trabajos en proceso, referencias a conversaciones anteriores que no conoces), responde SIEMPRE asi:
"Hola! 😊 Ya le aviso a Lili para que te confirme. En un momentico te escribe. [ESCALAR]"
Esto escala a Lili inmediatamente para que ella responda.

REGLA CRÍTICA — CUANDO NO SABES LA RESPUESTA:
Si alguien pregunta algo que no está en el catálogo ni en las reglas (si tienen tienda, horarios, redes sociales, referencias de clientes, etc.), SIEMPRE escala:
"Ya le aviso a Lili para que te confirme ese detalle 😊 [ESCALAR]"
NUNCA inventes información.

UBICACIÓN — RESPONDE SOLA, NUNCA ESCALES ESTO:
Si preguntan dónde están ubicados, si pueden ir a ver el producto, o algo similar, responde SIEMPRE así, sin escalar:
"Estamos en Medellín, por el sector de Guayabal 😊 Trabajamos 100% bajo pedido — todos nuestros productos son personalizados y se hacen en el momento del pedido, no tenemos tienda física con productos exhibidos."
Si después de esto insisten en ir personalmente o preguntan dirección exacta, ahí sí escala: "Ya le aviso a Lili para que te confirme ese detalle 😊 [ESCALAR]"
NUNCA digas que pueden venir a ver piezas exhibidas o visitar un showroom — no existe. Solo se ofrece mostrar fotos por WhatsApp.

DETECTAR CONTEXTO ROTO — CONVERSACIÓN INTERMEDIA:
Si hay historial previo Y el último mensaje del agente fue [ESCALAR] o hablar de cotización/precio personalizado/fotos, Y la respuesta del lead NO tiene coherencia directa con lo que el agente preguntó, significa que hubo una conversación intermedia que el agente no vio.
En ese caso SIEMPRE escalar con:
"¡Hola! 😊 Ya le aviso a Lili para que te confirme. En un momentico te escribe. [ESCALAR]"
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
  • Mesa auxiliar → NO requiere instalación. En Medellín se entrega COMPLETAMENTE ARMADA, lista para usar, sin ningún ensamble. Únicamente en otras ciudades se envía con patas desmontables (fácil ensamble con tornillos) para optimizar el envío — NUNCA menciones desmontaje ni tornillos si el cliente es de Medellín.
  • Mesa de centro con jardinera → NO requiere instalación. Solo Medellín.
  • Cama → requiere instalación (la instala Lili). Solo Medellín, sin envío a otras ciudades.

CATALOGO COMPLETO:

⛔ REGLA MAESTRA DE PRECIOS (LA MÁS IMPORTANTE — NUNCA LA ROMPAS):
- SOLO puedes dar los precios EXACTOS que están escritos en este catálogo, y SOLO para la medida EXACTA que aparece en la tabla (las 15 medidas exactas de repisas: 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200cm — o la medida estándar exacta de cada otro mueble).
- Si el cliente pide CUALQUIER medida distinta a las de la tabla (más grande, más pequeña, con decimales, o "parecida" a una que sí tiene precio), NUNCA calcules, estimes, redondees ni inventes un precio. El precio de una medida que no está en la tabla NO lo sabes — solo Lili lo sabe.
- ERROR GRAVE A EVITAR — REDONDEAR A LA MEDIDA MÁS CERCANA: si piden 136cm, NO es lo mismo que 130cm ni 140cm. Si piden 105cm, NO es lo mismo que 100cm ni 110cm. Aunque la diferencia parezca pequeña, NUNCA asumas que el precio es el de la medida más cercana de la tabla. Si el número exacto que pide el cliente no aparece en la lista de 15, escala — sin excepción.
- En medidas que no están en la tabla SIEMPRE escalas con algo como: "Esa medida la hacemos con gusto 😊 Ya le aviso a Lili para que te confirme el valor exacto. [ESCALAR]"${notaRedireccionV2Profundidad}
- Es mil veces mejor escalar y que Lili dé el precio, que inventar o redondear un número equivocado. Inventar un precio es el peor error que puedes cometer.

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
- Las repisas se pueden fabricar en cualquier largo, pero SOLO tienes precio confirmado para estas medidas exactas (profundidad 15cm):
${tablaPrecios}

ESPESOR — IMPORTANTE: el espesor estándar es 3.6cm (dos piezas de 18mm), PERO también se puede hacer en 3cm (dos piezas de 15mm) SIN cambio de precio ni de instalación — los herrajes invisibles funcionan igual de bien en los dos espesores. Si el lead pide específicamente 3cm o "más delgada", NO escales por eso — responde con naturalidad que sí se puede, mismo precio, y sigue con el flujo normal. SOLO escala si piden un espesor MENOR a 3cm (ahí sí hay riesgo real con los herrajes y se necesita revisión).
${bloqueCotizadorV2}
CUÁNDO OLIVIA CIERRA SOLA (sin escalar, SOLO para profundidad 15cm — para profundidad distinta, ya viste arriba cómo se maneja):
- La medida está en la tabla de 15 medidas de arriba (15cm de profundidad, espesor 3.6cm o 3cm — cualquiera de los dos).
- Es para Medellín (instalación incluida) O es envío a ciudad principal con valor de tabla.
- No hay ninguna complicación (no piden 30cm de profundidad, no es pared en L, no es cajón, no es módulo, no piden espesor menor a 3cm).
En estos casos Olivia cierra sola: da precio → confirma medida → explica pago (60/40 transferencia Bancolombia) → escala para que Lili reciba el anticipo.

${tituloEscalaSiempre}
${bulletProfundidadDistinta15cm}- Piden espesor MENOR a 3cm (ahí sí hay riesgo con los herrajes y se necesita revisión). Espesor de 3.6cm o 3cm NO escala, es normal.
- Pared en L, cajón integrado, módulo cerrado, tapa superior.
- Envío a ciudad NO principal (Ipiales, Pasto, o cualquier ciudad no listada en la tabla de envíos).
- Repisas de 180 o 200cm con envío (escalar para confirmar costo de envío con Lili).
- Combos con descuento (Olivia puede mencionarlos pero confirma con Lili antes de cerrar).
- Cualquier duda sobre material, sistema de instalación en muro especial.
${reglaDuraTexto}
- Instalacion: Incluida en Medellin
- Envio otras ciudades: SÍ se envía. Va empacada con sus soportes (el cliente la instala). NO hay instalación fuera de Medellín.
- VALORES DE ENVÍO según ciudad:

  CIUDADES PRINCIPALES — tarifa estándar:
  (Bogotá, Cali, Barranquilla, Pereira, Valledupar, Bucaramanga, Cartagena, Manizales, Armenia, Ibagué)
  60cm a 100cm → $35.000
  120cm a 160cm → $45.000
  180cm a 200cm → $45.000

  CIUDADES CON TARIFA ESPECIAL — tarifa fija $45.000 para TODAS las medidas:
  (Dosquebradas)
  Todas las medidas → $45.000

- Ciudades NO listadas arriba (Ipiales, Pasto, u otras no mencionadas): ESCALA para confirmar envío con Lili.
- Zonas difícil acceso (San Andrés, Leticia, Quibdó, Mitú, etc.): ESCALA siempre.
- Tiempo: 5-6 dias habiles
- Caracteristicas siempre mencionar: 15cm profundidad, espesor 3.6cm (estándar) o 3cm si lo prefieren, herrajes invisibles, esquinas redondeadas, bordes suaves, barniz protector

REGLA GLOBAL REPISAS — NUNCA menciones el uso específico (TV, baño, sala, cocina, etc.) en ningún mensaje. Habla siempre de la repisa de forma genérica. Si el lead lo menciona, ignóralo y sigue el flujo normal sin referenciarlo.
Las repisas son compra de impulso. El precio ya viene filtrado desde el anuncio.
- REGLA DE ORO DEL PRECIO (APLICA A TODO, INCLUSO REPISAS): el precio SIEMPRE va al FINAL del mensaje, NUNCA en la primera línea. Primero las características y el valor del producto (roble macizo, herrajes invisibles, esquinas redondeadas, profundidad, etc.), y al final, después de todo eso, el precio. NUNCA arranques un mensaje con "La repisa vale $X" o "Queda en $X". El precio cierra el mensaje, no lo abre.

FLUJO OBLIGATORIO PARA REPISAS — SIGUE ESTE ORDEN SIEMPRE:

${paso1Repisa}

${paso2Repisa}

PASO 2B — Lead dice sí a arrancar → dar método de pago + datos + escalar a Lili:
"Perfecto 🌿 El pago es por transferencia bancaria — el 60% de anticipo inicia la producción y el 40% restante lo pagas al momento de la entrega (o antes del envío si es otra ciudad).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

Cuando hagas el anticipo me avisas y arrancamos de una 😊 [ESCALAR]"

PASO 2C — Lead pide otra medida ESTÁNDAR → da precio + pre-cierre:
Las 15 medidas CON precio son: 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200cm. Para CUALQUIERA de estas das el precio directo, sin escalar, sin preguntar nada antes.
IMPORTANTE: 150cm SÍ tiene precio → da precio directo. 170cm NO tiene precio → escala.

REGLA DE LA CIUDAD — MUY IMPORTANTE: NO preguntes "¿es para Medellín o para otra ciudad?" como primer mensaje. Eso alarga innecesariamente. Da siempre el precio base (con instalación en Medellín) y agrega al final: "Si eres de otra ciudad el envío tiene un costo adicional 😊". Solo cuando el lead ya dijo que es de otra ciudad, das el precio con envío incluido.

REGLA CRÍTICA — CUANDO EL LEAD DICE SU CIUDAD SIN MENCIONAR MEDIDA:
Si el lead dice "estoy en Cali", "soy de Bogotá", "me queda en Barranquilla" u otra ciudad, sin haber mencionado qué medida quiere, NUNCA listes precios de varias medidas. Primero pregunta la medida, luego das UN solo precio con envío. Ejemplo correcto:
"Perfecto 😊 A Cali te la enviamos sin problema — va con sus soportes para que la instales tú. ¿Qué medida necesitas? Te paso el valor exacto con el envío incluido."
NUNCA hagas lo que sigue, esto es un ERROR GRAVE: listar 60cm, 80cm, 100cm, 120cm con sus precios cuando el lead aún no ha dicho qué medida quiere.

PASO 3 — Lead dice sí a arrancar con otra medida → dar método de pago + datos + escalar:
"Perfecto 🌿 El pago es por transferencia bancaria — el 60% de anticipo inicia la producción y el 40% restante lo pagas al momento de la entrega (o antes del envío si es otra ciudad).

Datos para la transferencia:
Bancolombia Ahorros
Cuenta: 10155134633
Titular: Liliana Hurtado
CC: 43873806

Cuando hagas el anticipo me avisas y arrancamos de una 😊 [ESCALAR]"

PASO 4 — Si lead confirma → escalar a Lili para proceso de pago
PASO 5 — Si piden medida que no está en las 15 → escalar para precio
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
"Es muy sencillo 😊 Va con soportes invisibles que se anclan a la pared y la repisa queda totalmente flotante."

4. RECIBIDOR / BANCO
- Medidas: 96 x 30 x 40 cm (incluye cojin)
- Incluye: cajon frontal, cojin
- Precio: $2.100.000 COP
- Tiempo: 15 dias habiles
- Envio: Consultar segun ciudad, escalar
- Instalacion: No requiere

5. MESA AUXILIAR
- Opciones:
  COMPACTA: 35 x 45 x 50 cm — $390.000 COP
  CLÁSICA: 45 x 45 x 50 cm — $420.000 COP
- Ensamble SEGÚN CIUDAD (nunca menciones esto sin condicionarlo a la ciudad del cliente):
  • Medellín: se entrega COMPLETAMENTE ARMADA, lista para usar. NUNCA digas que tiene patas desmontables ni que el cliente arma algo.
  • Otra ciudad: se envía con patas desmontables (fácil ensamble con tornillos), justamente para optimizar el envío.
- Tiempo: 8 dias habiles
- Envio: Sí, a todo Colombia. Envío nacional disponible, con costo adicional NO incluido en el precio del mueble. NUNCA inventes ni asumas el costo de envío — cuando el cliente sea de otra ciudad, escala a Lili para que confirme el valor exacto.
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
   - ACLARACIÓN REPISAS: "precio al final" NO significa alargar la conversación ni hacer más preguntas. Las repisas son compra de impulso. Solo significa el ORDEN dentro del mismo mensaje: características primero, precio de cierre. Ejemplo correcto para una medida estándar: "La de 120cm es en roble macizo, 15x3.6cm, herrajes invisibles, esquinas redondeadas, instalación incluida en Medellín. Queda en $280.000. ¿Arrancamos?" — todo en UN mensaje, sin preguntas extra.
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
- Si el lead insiste en otro método: "Ya le aviso a Lili para que te confirme esa opción 😊 [ESCALAR]"

DETECCIÓN DE PRODUCTO EN CUALQUIER MENSAJE:
Si en CUALQUIER momento de la conversación el lead menciona "repisa", "repisas", "estante", "estantes", "shelf", activa INMEDIATAMENTE el flujo de repisas — sin importar en qué punto va la conversación, sin importar si ya diste el saludo genérico.
NO sigas con preguntas genéricas como "¿buscas algo específico?" si ya mencionó repisa.
Ve directamente al PASO 1 del flujo de repisas.
Si el lead menciona una medida estándar Y un precio específico (ej: "me interesa la de 100cm"), significa que ya leyó la landing y ya eligió.
NO preguntes para qué es ni dónde va. Asume que ya decidió.
Responde validando su elección + diferenciadores clave + UNA sola pregunta de cierre: "¿Confirmamos esa medida y arrancamos?"

FLUJO ESPECIAL PARA REPISAS — LEAD PIDE AYUDA PARA ELEGIR MEDIDA:
Si el lead dice que no sabe qué medida necesita o pide ayuda para elegir:
Paso 1: Pregunta UNA sola cosa — el ancho disponible en la pared
Paso 2: Cuando responda el ancho → recomienda la medida correspondiente Y pregunta en qué espacio va (sala, dormitorio, baño, etc.)
Paso 3: Cuando diga dónde va → conecta emocionalmente con ese espacio específico y da el precio con contexto

PARA REPISAS MEDIDA NO ESTANDAR (solo medidas que NO están en la lista de 15 precios):
RECUERDA: las medidas CON precio son 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180 y 200cm. Para CUALQUIERA de estas 15 das el precio directo, NUNCA escalas.
Solo escalas para medidas que NO están en esa lista de 15: por ejemplo 170cm, cualquier medida por debajo de 40cm, o más de 200cm.
NUNCA digas "lamentablemente", "no las tenemos en el catálogo", "no manejamos esa medida" ni nada negativo — SIEMPRE en positivo.

PARA LA CAMA:
- Primer mensaje: presentar ambas opciones SIN precio
- Preguntar tamaño, sin ofrecer fotos por iniciativa propia
- Si pide fotos: "Claro! Ya le aviso a Lili para que te mande las fotos 😊 [ESCALAR]"
- Dar precio solo despues de confirmar tamano Queen

CUANDO ESCALAR (respuestas naturales y cálidas. Como Olivia es del equipo, SÍ puede referirse a Lili con naturalidad, ej: "ya le aviso a Lili"):
- CLIENTE PIDE HABLAR CON UNA PERSONA O ASESOR: Si el cliente dice cosas como "quiero hablar con un asesor", "quiero hablar con una persona", "con un humano", "con alguien real", "con Lili", "me pueden llamar", "necesito hablar con alguien", o muestra frustración con tus respuestas, escala de inmediato con calidez: "¡Claro! Ya le aviso a Lili para que te atienda personalmente 😊 En un momentico te escribe. [ESCALAR]"
- Fotos de la REPISA (cómo es, cómo queda, cómo se ve), SOLO cuando el cliente las pide explícitamente: el sistema las envía automáticamente. Debes responder EXACTAMENTE así, sin cambiar nada: "¡Claro! Aquí te muestro cómo queda 😊 [FOTOS_EXTRA]" — el tag [FOTOS_EXTRA] es OBLIGATORIO, sin él las fotos no se envían. NUNCA escribas esta respuesta sin el tag y NUNCA ofrezcas tú primero enviar fotos.
- Fotos de REFERENCIA o ESTILO (para elegir diseño, estilo, color): "Claro! Ya le aviso a Lili para que te pase algunas opciones de referencia y elijas el estilo 😊 [ESCALAR]"
- Medidas no estandar: "Perfecto! Ya le aviso a Lili para que revise las medidas y te confirme el valor 😊 [ESCALAR]"${notaRedireccionV2Profundidad}
- Diseno personalizado: "Claro! Ya le aviso a Lili para que te pase opciones de referencia 😊 [ESCALAR]"
- Envio cama o mesa: "Para ese detalle de envío, ya le aviso a Lili para que lo revise y te confirme 😊 [ESCALAR]"
- Tamanos no estandar cama: "Claro! Ya le aviso a Lili para que revise las medidas y te prepare la cotización 😊 [ESCALAR]"
- Contexto desconocido: "Hola! 😊 Ya le aviso a Lili para que te confirme. En un momentico te escribe. [ESCALAR]"
- Otra ciudad — DEPENDE DEL PRODUCTO:
  • REPISAS: SÍ se envía con los valores ya indicados ($35.000 para 60-100cm, $45.000 para 120-160cm). Responde el valor de envío directamente, sin escalar, salvo zonas de difícil acceso (San Andrés, Leticia, Quibdó, etc.) que sí se escalan. Recuerda: fuera de Medellín no hay instalación, el cliente la instala (es flotante con soportes).
  • ESCRITORIO FLOTANTE: se envía a todo Colombia, pero fuera de Medellín no se instala. Si preguntan, dilo claro.
  • MESA AUXILIAR: se envía a todo Colombia (puede ir desarmada, el cliente la arma). El costo del envío NO está incluido en el precio del mueble y NUNCA lo inventas ni lo asumes en $0 — confirma que sí se envía, y para el valor exacto escala: "Para tu ciudad sí llega 😊 Ya le aviso a Lili para que te confirme el valor exacto del envío. [ESCALAR]"
  • ESCRITORIO CON CAJONES, MESA DE CENTRO, CAMA: solo Medellín. Si son de otra ciudad: "Ese mueble por ahora lo manejamos en Medellín. Ya le aviso a Lili para que te confirme si hay alguna opción para tu ciudad 😊 [ESCALAR]"

IMPORTANTE: [ESCALAR] es interno, el sistema lo elimina del mensaje al cliente y notifica a Lili.

TIEMPO: NUNCA digas "en un momento" para cotizaciones — puede tomar horas o dias.
${reglasCampana}`;
}


// ═══════════════════════════════════════════════════════════════════════════
// 🔧 FIX (25 jun): notificarLili() causaba el loop de 50+ mensajes a Telegram.
// El problema: esta función intentaba avisar por DOS canales (Telegram Y
// WhatsApp). Cuando un mensaje fallaba en entregarse a LILI_NUMERO (ventana de
// 24h cerrada), Meta disparaba un evento "failed" que llamaba a notificarLili,
// la cual intentaba avisar por WhatsApp a ese MISMO número — ese intento
// también fallaba, generando OTRO evento "failed", que volvía a llamar a
// notificarLili, en un ciclo que se alimentaba a sí mismo indefinidamente.
// Fix: SOLO Telegram (no tiene restricción de ventana de 24h, así que no
// puede fallar por esa razón y no puede retroalimentar el loop) + 
// deduplicación para que, aunque algo dispare varias notificaciones seguidas
// para el mismo número en poco tiempo, solo se manden una vez cada 5 minutos.
// ═══════════════════════════════════════════════════════════════════════════
const notificacionesRecientes = {};

function notificarLili(from, motivo) {
  var clave = 'notif_' + from;
  var ahora = Date.now();
  if (notificacionesRecientes[clave] && (ahora - notificacionesRecientes[clave]) < 5 * 60 * 1000) {
    console.log('⏭️ Notificación duplicada ignorada para ' + from + ' (ya se envió hace menos de 5 min)');
    return;
  }
  notificacionesRecientes[clave] = ahora;

  var mensaje = '🔔 LEAD NECESITA TU ATENCION\n\nNumero: ' + from + '\nSolicitud: ' + motivo + '\n\nRevisa la conversacion y responde cuando puedas 👍';

  axios.post(
    'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage',
    { chat_id: TELEGRAM_CHAT_ID, text: mensaje }
  ).then(function() {
    console.log('Notificacion Telegram enviada a Lili sobre ' + from);
  }).catch(function(error) {
    console.error('Error notificando Telegram:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}

app.get('/control', function(req, res) {
  var token = req.query.token;
  var cmd = req.query.cmd;
  var numero = req.query.numero;
  if (!tokenValido(token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');
  if (numero) numero = numero.replace(/[+\s-]/g, '');
  if (numero && !esNumeroValido(numero)) return res.status(400).send('Numero invalido');
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

// ═══════════════════════════════════════════════════════════════════════════
// Exportación de leads para audiencia personalizada en Meta Ads.
// Devuelve un CSV listo para subir: columna "phone", formato internacional,
// sin duplicados, sin el número de Lili ni el de WhatsApp Business.
// URL: /exportar-leads?token=TU_TOKEN
// ═══════════════════════════════════════════════════════════════════════════
// Endpoint de prueba para verificar qué modo está activo (campaña o normal)
// URL: /modo-campana?token=TU_TOKEN
app.get('/modo-campana', function(req, res) {
  if (!tokenValido(req.query.token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');
  var activa = esCampanaActiva();
  var ahoraUTC = new Date();
  var ahoraColombia = new Date(ahoraUTC.getTime() - 5 * 60 * 60 * 1000);
  res.json({
    campana_activa: activa,
    modo: activa ? '🎯 JULIO DE ROBLE — precios promocionales activos' : '✅ NORMAL — precios originales',
    hora_colombia: ahoraColombia.toISOString().replace('T', ' ').slice(0, 19) + ' COT',
    fin_campana: '2026-07-20 23:59 COT',
    precio_60cm_activo: activa ? '$175.000' : '$220.000',
    precio_100cm_activo: activa ? '$255.000' : '$320.000',
    precio_160cm_activo: activa ? '$335.000' : '$420.000'
  });
});

app.get('/exportar-leads', async function(req, res) {
  if (!tokenValido(req.query.token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');

  var EXCLUIDOS = ['573008654336', '573334318777'];
  if (LILI_NUMERO) EXCLUIDOS.push(LILI_NUMERO);

  try {
    var result = await pool.query('SELECT DISTINCT numero FROM conversaciones');
    var numeros = result.rows
      .map(function(row) { return String(row.numero).replace(/[^0-9]/g, ''); })
      .filter(function(n) {
        if (!n || n.length < 8) return false;
        // Agregar prefijo 57 si no lo tiene (números colombianos de 10 dígitos)
        if (n.length === 10 && !n.startsWith('57')) n = '57' + n;
        return !EXCLUIDOS.includes(n);
      })
      .map(function(n) {
        if (n.length === 10 && !n.startsWith('57')) return '57' + n;
        return n;
      });

    // Deduplicar después del formateo
    var unicos = Array.from(new Set(numeros));

    var csv = 'phone\n' + unicos.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_julio_retargeting.csv"');
    res.send(csv);

    console.log('Exportación CSV: ' + unicos.length + ' leads únicos exportados para Meta Ads');
  } catch (e) {
    console.error('Error exportando leads:', e.message);
    res.status(500).send('Error generando el archivo: ' + e.message);
  }
});

app.get('/reporte', function(req, res) {
  if (!tokenValido(req.query.token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');

  var todos = {};
  Object.keys(conversaciones).forEach(function(n) { if (n !== LILI_NUMERO) todos[n] = true; });
  Object.keys(seguimientos).forEach(function(n) { if (n !== LILI_NUMERO) todos[n] = true; });

  var cat = {
    en_conversacion: [], saludo_sin_respuesta: [], esperando_info: [],
    esperando_decision: [], cotizacion_enviada: [], cerrado_sin_respuesta: [], cerrado_venta: [], cerrado_perdido: []
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
    cerrado_sin_respuesta: '❄️ Sin respuesta — disponibles para reactivar',
    cerrado_venta: '✅ Venta cerrada',
    cerrado_perdido: '❌ Perdidos / cerrados (decisión tuya)'
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
    else { lista.forEach(function(n) { html += '<div class="num">' + escapeHtml(n) + '</div>'; }); }
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
    cerrado_perdido: '❌ Perdido / cerrado',
    cerrado_sin_respuesta: '❄️ Sin respuesta — disponible para reactivar'
  };
  return map[seg.estado] || seg.estado;
}

app.get('/panel', function(req, res) {
  if (!tokenValido(req.query.token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');
  var leads = Object.keys(conversaciones).filter(function(n) { return n !== LILI_NUMERO; });
  leads.sort(function(a, b) {
    var ta = ultimaActividad[a] || 0;
    var tb = ultimaActividad[b] || 0;
    return tb - ta;
  });

  var mios = [];
  var deOlivia = [];
  var ventas = [];
  var perdidos = [];
  leads.forEach(function(n) {
    var seg = seguimientos[n];
    if (seg && seg.estado === 'cerrado_venta') { ventas.push(n); return; }
    // "Perdidos" agrupa los dos casos en los que ya no se sigue insistiendo:
    // cerrado_perdido = tú lo marcaste manualmente como "no va a comprar"
    // cerrado_sin_respuesta = Olivia hizo 2 intentos de seguimiento y nadie respondió
    if (seg && (seg.estado === 'cerrado_perdido' || seg.estado === 'cerrado_sin_respuesta')) { perdidos.push(n); return; }
    if (pausados[n]) {
      mios.push(n);
    } else {
      deOlivia.push(n);
    }
  });

  // "Fríos" = sin actividad hace 5+ días y NO cerrados (venta ni perdido)
  var CINCO_DIAS_MS = 5 * 24 * 60 * 60 * 1000;
  var ahoraTs = Date.now();
  var frios = [];
  leads.forEach(function(n) {
    var seg = seguimientos[n];
    var cerrado = seg && (seg.estado === 'cerrado_venta' || seg.estado === 'cerrado_perdido');
    if (cerrado) return;
    var ultima = ultimaActividad[n] || 0;
    if (ahoraTs - ultima >= CINCO_DIAS_MS) frios.push(n);
  });
  frios.sort(function(a, b) { return (ultimaActividad[a] || 0) - (ultimaActividad[b] || 0); });

  function tarjetaLead(n, conCheckbox) {
    var dias = Math.floor((ahoraTs - (ultimaActividad[n] || 0)) / (24 * 60 * 60 * 1000));
    var h = conCheckbox ? '<div class="lead lead-frio">' : ('<a class="lead" href="/panel/chat?token=' + CONTROL_TOKEN + '&numero=' + encodeURIComponent(n) + '">');
    if (conCheckbox) {
      h += '<label class="check-wrap"><input type="checkbox" class="chk-frio" value="' + escapeHtml(n) + '">';
      h += '<span><div class="num">+' + escapeHtml(n) + '</div>';
      h += '<div class="est">' + estadoLegible(n) + ' · ' + dias + ' días sin actividad</div>';
      if (notas[n]) h += '<div class="nota-prev">📝 ' + escapeHtml(notas[n]) + '</div>';
      h += '</span></label>';
      h += '<a class="ver-chat" href="/panel/chat?token=' + CONTROL_TOKEN + '&numero=' + encodeURIComponent(n) + '">Ver chat →</a>';
    } else {
      h += '<div class="num">+' + escapeHtml(n) + '</div>';
      h += '<div class="est">' + estadoLegible(n) + '</div>';
      if (notas[n]) h += '<div class="nota-prev">📝 ' + escapeHtml(notas[n]) + '</div>';
    }
    h += conCheckbox ? '</div>' : '</a>';
    return h;
  }

  function listaGrupo(arr, conCheckbox) {
    if (arr.length === 0) return '<div class="vacio">No hay leads en este grupo.</div>';
    return arr.map(function(n) { return tarjetaLead(n, conCheckbox); }).join('');
  }

  var html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>Panel — Hecho por Lili</title><style>';
  html += 'body{font-family:-apple-system,sans-serif;background:#f5f3ef;margin:0;padding:16px;color:#3a342e}';
  html += 'h1{font-size:20px;margin-bottom:12px}';
  html += '.tabs{display:flex;gap:8px;margin-bottom:16px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px}';
  html += '.tab{flex:0 0 auto;white-space:nowrap;text-align:center;padding:12px 14px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;background:#e8e3db;color:#7a7268;border:none}';
  html += '.tab.activa{background:#3a342e;color:#fff}';
  html += '.lead{display:block;background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:10px;text-decoration:none;color:#3a342e;box-shadow:0 1px 3px rgba(0,0,0,.06)}';
  html += '.num{font-family:monospace;font-size:15px;font-weight:600}';
  html += '.est{font-size:13px;color:#7a7268;margin-top:4px}';
  html += '.nota-prev{font-size:12px;color:#4a7c4e;margin-top:6px;background:#f0f5ee;padding:6px 8px;border-radius:6px}';
  html += '.vacio{color:#aaa;font-style:italic;padding:10px 0}';
  html += '.grupo{display:none}.grupo.activo{display:block}';
  html += '.lead-frio{display:flex;align-items:center;justify-content:space-between;gap:8px}';
  html += '.check-wrap{display:flex;align-items:flex-start;gap:10px;flex:1;cursor:pointer}';
  html += '.check-wrap input{margin-top:4px;width:18px;height:18px;flex-shrink:0}';
  html += '.ver-chat{font-size:12px;color:#7a7268;text-decoration:none;white-space:nowrap}';
  html += '.barra-frios{position:sticky;top:0;background:#f5f3ef;padding:10px 0;margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}';
  html += '.btn-sel{border:1px solid #cdbfae;background:#fff;color:#5a534b;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}';
  html += '.btn-reactivar{border:none;background:#4a7c4e;color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer}';
  html += '.contador-sel{font-size:13px;color:#7a7268}';
  html += '.nota-input{width:100%;box-sizing:border-box;border:1px solid #cdbfae;border-radius:8px;padding:9px;font-size:14px;font-family:inherit;resize:vertical;min-height:50px;margin-bottom:6px}';
  html += '.marcar-titulo{font-size:11px;color:#7a7268;text-align:left;margin-top:10px;margin-bottom:6px}';
  html += '</style></head><body>';
  html += '<h1>🌿 Panel de Conversaciones</h1>';
  html += '<input type="text" id="buscar" placeholder="🔍 Buscar por número..." style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #cdbfae;border-radius:10px;font-size:15px;margin-bottom:12px;font-family:inherit" oninput="filtrarLeads(this.value)">';

  html += '<div class="tabs">';
  html += '<button class="tab activa" id="tab-mios" onclick="verGrupo(\'mios\')">🔵 Atendiendo yo (' + mios.length + ')</button>';
  html += '<button class="tab" id="tab-olivia" onclick="verGrupo(\'olivia\')">🟢 Olivia maneja (' + deOlivia.length + ')</button>';
  html += '<button class="tab" id="tab-ventas" onclick="verGrupo(\'ventas\')">✅ Ventas (' + ventas.length + ')</button>';
  html += '<button class="tab" id="tab-perdidos" onclick="verGrupo(\'perdidos\')">❌ Perdidos (' + perdidos.length + ')</button>';
  html += '<button class="tab" id="tab-frios" onclick="verGrupo(\'frios\')">❄️ Fríos (' + frios.length + ')</button>';
  html += '</div>';

  html += '<div class="grupo activo" id="grupo-mios">' + listaGrupo(mios, false) + '</div>';
  html += '<div class="grupo" id="grupo-olivia">' + listaGrupo(deOlivia, false) + '</div>';
  html += '<div class="grupo" id="grupo-ventas">' + listaGrupo(ventas, false) + '</div>';
  html += '<div class="grupo" id="grupo-perdidos">' + listaGrupo(perdidos, false) + '</div>';

  html += '<div class="grupo" id="grupo-frios">';
  html += '<div class="barra-frios">';
  html += '<button class="btn-sel" onclick="seleccionarTodos(true)">Seleccionar todos</button>';
  html += '<button class="btn-sel" onclick="seleccionarTodos(false)">Ninguno</button>';
  html += '<span class="contador-sel" id="contador-sel">0 seleccionados</span>';
  html += '</div>';
  html += '<div class="marcar-titulo">Mensaje de reactivación que se enviará:</div>';
  html += '<textarea id="msg-reactivacion" class="nota-input" style="margin-bottom:10px">Hola! 😊 Hace unos días me escribiste por la repisa en roble. ¿Todavía la estás pensando? Tengo cupo de fabricación esta semana si quieres que te la deje lista 🌿</textarea>';
  html += '<button class="btn-reactivar" onclick="reactivarSeleccionados()" id="btn-reactivar" style="width:100%;margin-bottom:14px;padding:12px">📨 Reactivar seleccionados</button>';
  html += listaGrupo(frios, true);
  html += '</div>';

  html += '<script>';
  html += 'var TK_PANEL="' + CONTROL_TOKEN + '";';
  html += 'function filtrarLeads(q){';
  html += 'q=q.replace(/[^0-9]/g,"");';
  html += 'var items=document.querySelectorAll(".lead,.lead-frio");';
  html += 'items.forEach(function(el){';
  html += 'var num=el.querySelector(".num");';
  html += 'if(!num){el.style.display="";return;}';
  html += 'var texto=num.textContent.replace(/[^0-9]/g,"");';
  html += 'el.style.display=(!q||texto.indexOf(q)!==-1)?"":"none";';
  html += '});';
  html += '}';
  html += 'function verGrupo(g){';
  html += 'var grupos=["mios","olivia","ventas","perdidos","frios"];';
  html += 'grupos.forEach(function(x){';
  html += 'document.getElementById("grupo-"+x).className = g===x ? "grupo activo" : "grupo";';
  html += 'document.getElementById("tab-"+x).className = g===x ? "tab activa" : "tab";';
  html += '});';
  html += '}';
  html += 'function actualizarContador(){';
  html += 'var n=document.querySelectorAll(".chk-frio:checked").length;';
  html += 'document.getElementById("contador-sel").textContent=n+" seleccionados";';
  html += '}';
  html += 'document.addEventListener("change",function(e){if(e.target.classList.contains("chk-frio"))actualizarContador();});';
  html += 'function seleccionarTodos(valor){';
  html += 'document.querySelectorAll(".chk-frio").forEach(function(c){c.checked=valor;});';
  html += 'actualizarContador();}';
  html += 'function reactivarSeleccionados(){';
  html += 'var seleccionados=[];';
  html += 'document.querySelectorAll(".chk-frio:checked").forEach(function(c){seleccionados.push(c.value);});';
  html += 'if(seleccionados.length===0){alert("Selecciona al menos un lead");return;}';
  html += 'var mensaje=document.getElementById("msg-reactivacion").value.trim();';
  html += 'if(!mensaje){alert("Escribe el mensaje de reactivación");return;}';
  html += 'if(!confirm("¿Enviar este mensaje a "+seleccionados.length+" leads? Quedarán pausados para que les hagas seguimiento."))return;';
  html += 'var b=document.getElementById("btn-reactivar");b.disabled=true;b.textContent="Enviando...";';
  html += 'fetch("/panel/reactivar-tanda",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK_PANEL,numeros:seleccionados,mensaje:mensaje})})';
  html += '.then(function(r){return r.json()}).then(function(d){';
  html += 'if(d.ok){alert("Enviado a "+d.enviados+" leads 🌿");location.reload();}';
  html += 'else{alert("Error al enviar");b.disabled=false;b.textContent="📨 Reactivar seleccionados";}';
  html += '}).catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="📨 Reactivar seleccionados";});';
  html += '}';
  html += '</script>';
  html += '</body></html>';
  res.send(html);
});

app.get('/panel/chat', function(req, res) {
  if (!tokenValido(req.query.token, CONTROL_TOKEN)) return res.status(403).send('No autorizado');
  var numero = req.query.numero;
  if (numero) numero = numero.replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.status(400).send('Numero invalido');
  var conv = conversaciones[numero] || [];

  var html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>+' + escapeHtml(numero) + '</title><style>';
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
  html += '.btn-borrar{width:100%;background:#8a2e2e;margin-top:4px}';
  html += '.nota-input{width:100%;box-sizing:border-box;border:1px solid #cdbfae;border-radius:8px;padding:9px;font-size:14px;font-family:inherit;resize:vertical;min-height:50px;margin-bottom:6px}';
  html += '.btn-nota{width:100%;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;background:#4a7c4e;color:#fff}';
  html += '.acciones-panel{display:none;max-height:55vh;overflow-y:auto;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #cdbfae}';
  html += '.acciones-panel.abierto{display:block}';
  html += '.btn-acciones{background:#8a7f70;color:#fff}';
  html += '.btn-accion-full{width:100%;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:4px}';
  html += '.aviso{font-size:12px;color:#7a7268;text-align:center;margin-top:6px}';
  html += '.media-img{max-width:100%;border-radius:8px;display:block;cursor:pointer}';
  html += '.media-audio{max-width:240px}';
  html += '.media-tag{font-style:italic;color:#5a534b}';
  html += '.btn-media{flex:1;border:1px solid #cdbfae;background:#fff;color:#5a534b;border-radius:8px;padding:9px 4px;font-size:12px;font-weight:600;cursor:pointer}';
  html += '.ts{font-size:11px;color:#999;margin-top:4px;text-align:right}';
  // 🆕 FASE 1A, PASO 9 — aviso de bajo impacto sobre mensajes manuales de WhatsApp Business
  html += '.aviso-manual{background:#fff6d9;color:#6b5a1e;font-size:12px;padding:8px 12px;text-align:center;border-bottom:1px solid #e8dca0}';
  html += '</style></head><body>';
  html += '<div class="top"><a href="/panel?token=' + CONTROL_TOKEN + '">← Volver a leads</a>';
  html += '<div class="n">+' + escapeHtml(numero) + '</div>';
  html += '<div class="est">' + estadoLegible(numero) + '</div></div>';
  html += '<div class="aviso-manual">Para que Olivia conserve el contexto completo, responde desde este panel o registra aquí la respuesta enviada por WhatsApp Business.</div>';
  html += '<div class="wrap">';

  if (conv.length === 0) {
    html += '<div class="vacio">No hay mensajes guardados de este número.</div>';
  } else {
    conv.forEach(function(m) {
      var clase = m.role === 'user' ? 'lead' : 'lili';
      var horaHtml = '';
      if (m.ts) {
        var d = new Date(m.ts - 5 * 60 * 60 * 1000);
        var dia = d.getUTCDate();
        var mes = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][d.getUTCMonth()];
        var hh = String(d.getUTCHours()).padStart(2,'0');
        var mm = String(d.getUTCMinutes()).padStart(2,'0');
        horaHtml = '<div class="ts">' + dia + ' ' + mes + ' · ' + hh + ':' + mm + '</div>';
      }
      var contenidoHtml;
      if (typeof m.content === 'string' && m.content.indexOf('[IMAGEN] ') === 0) {
        var urlImg = m.content.slice(9);
        contenidoHtml = '<img src="' + escapeHtml(urlImg) + '" class="media-img" onclick="window.open(this.src)">';
      } else if (typeof m.content === 'string' && m.content.indexOf('[AUDIO] ') === 0) {
        var urlAud = m.content.slice(8);
        contenidoHtml = '<audio controls src="' + escapeHtml(urlAud) + '" class="media-audio"></audio>';
      } else if (typeof m.content === 'string' && (m.content.indexOf('[Lili envió una imagen]') === 0)) {
        contenidoHtml = '<span class="media-tag">📷 Imagen enviada</span>';
      } else if (typeof m.content === 'string' && (m.content.indexOf('[Lili envió un audio]') === 0)) {
        contenidoHtml = '<span class="media-tag">🎤 Audio enviado</span>';
      } else {
        contenidoHtml = escapeHtml(m.content);
      }
      html += '<div class="row"><div class="msg ' + clase + '">' + contenidoHtml + horaHtml + '</div></div>';
    });
  }
  html += '</div>';

  var estaPausado = pausados[numero] ? true : false;
  html += '<div class="barra">';
  html += '<div id="acciones" class="acciones-panel">';
  html += '<div class="aviso">' + (estaPausado ? 'El agente está pausado — tú atiendes este lead' : 'El agente está activo en este lead') + '</div>';
  if (estaPausado) {
    html += '<button class="btn-accion-full btn-agente" onclick="agente(\'reanudar\')">▶️ Activar agente Olivia</button>';
  } else {
    html += '<button class="btn-accion-full btn-agente" onclick="agente(\'pausa\')">⏸️ Pausar agente (atiendo yo)</button>';
  }
  html += '<div class="marcar-titulo">Si lleva más de 24h sin escribirte y necesitas reabrir la conversación:</div>';
  html += '<button class="btn-accion-full" style="background:#d9a04a;color:#fff" onclick="dispararPlantilla(event)">📨 Enviar plantilla de reapertura</button>';
  html += '<div class="marcar-titulo">Avisarle al agente que ya enviaste (por WhatsApp):</div>';
  html += '<div class="fila-marcar">';
  html += '<button class="btn-marcar" onclick="marcar(\'esperando_decision\',event)">📸 Fotos enviadas</button>';
  html += '<button class="btn-marcar" onclick="marcar(\'cotizacion_enviada\',event)">📋 Cotización enviada</button>';
  html += '<button class="btn-marcar" onclick="marcar(\'esperando_info\',event)">📏 Espero medidas</button>';
  html += '</div>';
  html += '<div class="marcar-titulo">Enviar imagen o audio al lead:</div>';
  html += '<div class="fila-marcar">';
  html += '<button class="btn-media" onclick="document.getElementById(\'archivo-img\').click()">📷 Imagen</button>';
  html += '<button class="btn-media" onclick="document.getElementById(\'archivo-audio\').click()">🎤 Audio</button>';
  html += '</div>';
  html += '<div class="marcar-titulo">Cerrar este lead:</div>';
  html += '<div class="fila-marcar">';
  html += '<button class="btn-cerrar btn-venta" onclick="cerrar(\'cerrado_venta\',event)">✅ Venta cerrada</button>';
  html += '<button class="btn-cerrar btn-perdido" onclick="cerrar(\'cerrado_perdido\',event)">❌ No va a comprar</button>';
  html += '</div>';
  html += '<div class="marcar-titulo">¿Lead cerrado que volvió a escribir?</div>';
  html += '<button class="btn-accion-full" style="background:#5a7fbd;color:#fff;margin-bottom:4px" onclick="reabrirLead(event)">🔄 Reabrir lead (pasa a Atendiendo yo)</button>';
  html += '<div class="marcar-titulo">📝 Nota privada (lo que hablaste por audio, qué esperas, etc.):</div>';
  html += '<textarea id="nota" class="nota-input" placeholder="Ej: Quedó de mandar fotos del material el viernes...">' + escapeHtml(notas[numero] || '') + '</textarea>';
  html += '<button class="btn-nota" onclick="guardarNota(event)">Guardar nota</button>';
  html += '<div class="marcar-titulo">🗑️ Solo para pruebas (borra TODO el historial de este número):</div>';
  html += '<button class="btn-cerrar btn-borrar" onclick="borrarHistorial(event)">🗑️ Borrar historial completo</button>';
  html += '</div>';
  html += '<textarea id="txt" placeholder="Escribe tu respuesta..."></textarea>';
  html += '<div class="fila">';
  html += '<button class="btn btn-enviar" onclick="enviar(event)">Enviar</button>';
  html += '<button class="btn btn-acciones" onclick="toggleAcciones()">⚙️ Acciones</button>';
  html += '</div>';
  html += '<input type="file" id="archivo-img" accept="image/*" style="display:none" onchange="enviarArchivo(this,\'imagen\')">';
  html += '<input type="file" id="archivo-audio" accept="audio/*" style="display:none" onchange="enviarArchivo(this,\'audio\')">';
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
  html += 'function dispararPlantilla(e){';
  html += 'if(!confirm("Se va a enviar este mensaje EXACTO a +"+NUM+":\\n\\n\\"Hola! 😊 Quería saber si pudiste revisar la información de tu repisa en roble. Cuéntame si tienes alguna duda, con gusto te ayudo 🌿\\"\\n\\nÚsalo solo si lleva más de 24h sin escribirte. El lead quedará PAUSADO (tú sigues con el control) — si prefieres que Olivia continúe sola cuando responda, activa el agente después con el botón de arriba."))return;';
  html += 'var b=e.target;b.disabled=true;b.textContent="Enviando...";';
  html += 'fetch("/panel/enviar-plantilla",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.reload()}else{alert("Error al enviar la plantilla");b.disabled=false;b.textContent="📨 Enviar plantilla de reapertura"}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="📨 Enviar plantilla de reapertura"});}';
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
  html += 'function reabrirLead(e){';
  html += 'if(!confirm("¿Reabrir este lead? Pasará a \'Atendiendo yo\' y Olivia no lo manejará hasta que lo actives."))return;';
  html += 'var b=e.target;b.disabled=true;b.textContent="Reabriendo...";';
  html += 'fetch("/panel/reabrir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.reload()}else{alert("Error");b.disabled=false;b.textContent="🔄 Reabrir lead"}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="🔄 Reabrir lead"});}';  html += 'window.scrollTo(0, document.body.scrollHeight);';
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
  html += 'function enviarArchivo(input,tipo){';
  html += 'var f=input.files[0];if(!f)return;';
  html += 'var fd=new FormData();fd.append("archivo",f);fd.append("token",TK);fd.append("numero",NUM);fd.append("tipo",tipo);';
  html += 'alert("Enviando "+tipo+"... espera un momento 😊");';
  html += 'fetch("/panel/enviar-archivo",{method:"POST",body:fd})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.reload()}else{alert("Error: "+(d.error||"no se pudo enviar"))}})';
  html += '.catch(function(){alert("Error de conexion al enviar el archivo")});';
  html += 'input.value="";}';
  html += 'function borrarHistorial(e){';
  html += 'if(!confirm("¿Borrar TODO el historial de +"+NUM+"? Esto no se puede deshacer. Úsalo solo para tus pruebas."))return;';
  html += 'if(!confirm("Confirma una vez más: se borrará la conversación, notas y estado de este número."))return;';
  html += 'var b=e.target;b.disabled=true;b.textContent="Borrando...";';
  html += 'fetch("/panel/borrar-historial",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TK,numero:NUM})})';
  html += '.then(function(r){return r.json()}).then(function(d){if(d.ok){alert("Historial borrado 🌿");window.location.href="/panel?token="+TK}else{alert("Error");b.disabled=false;b.textContent="🗑️ Borrar historial completo"}})';
  html += '.catch(function(){alert("Error de conexion");b.disabled=false;b.textContent="🗑️ Borrar historial completo"});}';
  html += '</script>';
  html += '</body></html>';
  res.send(html);
});

app.post('/panel/enviar', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  var texto = req.body.texto || '';
  if (!esNumeroValido(numero) || !texto) return res.json({ ok: false });

  marcarPausado(numero);
  agregarMensaje(numero, 'assistant', texto);
  cancelarSeguimiento(numero);

  enviarMensaje(numero, texto);
  console.log('Respuesta manual desde panel a ' + numero);
  res.json({ ok: true });
});

// Enviar imagen o audio desde el panel directamente al lead por WhatsApp.
// Se sube a Cloudinary, se manda por la API de Meta, y se guarda una referencia
// en el historial para que se vea en el panel (no se puede mostrar el archivo
// real dentro del historial de texto, pero queda claro que se envió).
app.post('/panel/enviar-archivo', upload.single('archivo'), function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.json({ ok: false });
  if (!req.file) return res.json({ ok: false, error: 'No se recibió ningún archivo' });

  var tipo = req.body.tipo === 'audio' ? 'audio' : 'imagen';
  var esVideo = tipo === 'audio'; // para Cloudinary, audio se sube como "video"

  subirACloudinary(req.file.buffer, req.file.mimetype, esVideo)
    .then(function(url) {
      marcarPausado(numero);

      var envio = tipo === 'audio' ? enviarAudio(numero, url) : enviarImagen(numero, url);

      return envio.then(function() {
        var etiqueta = tipo === 'audio' ? '[Lili envió un audio]' : '[Lili envió una imagen]';
        agregarMensaje(numero, 'assistant', etiqueta);
        cancelarSeguimiento(numero);
        console.log((tipo === 'audio' ? 'Audio' : 'Imagen') + ' enviado desde panel a ' + numero);
        res.json({ ok: true, url: url });
      });
    })
    .catch(function(error) {
      console.error('Error subiendo/enviando archivo del panel:', error.message);
      res.json({ ok: false, error: 'No se pudo enviar el archivo' });
    });
});

app.post('/panel/marcar', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  var estado = req.body.estado || '';
  var estadosValidos = ['esperando_info', 'esperando_decision', 'cotizacion_enviada'];
  if (!esNumeroValido(numero) || estadosValidos.indexOf(estado) === -1) return res.json({ ok: false });

  seguimientos[numero] = { estado: estado, timestamp: Date.now(), intentos: 0 };
  guardarSeguimiento(numero);
  console.log('Estado marcado desde panel para ' + numero + ': ' + estado);
  res.json({ ok: true });
});

// Disparo manual de la plantilla de reapertura, para cuando Lili necesita más
// de 24h para preparar algo (cotización, fotos) y quiere "tocar la puerta" de
// un lead específico sin esperar al cron automático.
// IMPORTANTE: esto PAUSA al lead automáticamente (igual que cuando Lili responde
// desde el panel), porque normalmente este botón se usa cuando se está esperando
// algo específico (fotos, medidas, color) que Olivia no puede resolver sola.
// Si en algún caso Lili SÍ quiere que Olivia siga la conversación después de que
// el lead responda, puede activar el agente con el botón "▶️ Activar agente
// Olivia" justo después de mandar la plantilla.
app.post('/panel/enviar-plantilla', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.json({ ok: false });

  enviarPlantilla(numero, 'seguimiento_repisa', 'es_CO').then(function() {
    marcarPausado(numero);
    agregarMensaje(numero, 'assistant', '[Lili reabrió la conversación con la plantilla de WhatsApp: "Hola! 😊 Quería saber si pudiste revisar la información de tu repisa en roble. Cuéntame si tienes alguna duda, con gusto te ayudo 🌿"]');
    cancelarSeguimiento(numero);
    console.log('Plantilla disparada manualmente desde panel a ' + numero + ' — número pausado para que Lili mantenga el control');
    res.json({ ok: true });
  }).catch(function(error) {
    console.error('Error disparando plantilla manual:', error.message);
    res.json({ ok: false });
  });
});

app.post('/panel/nota', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.json({ ok: false });
  var nota = (req.body.nota || '').slice(0, 1000);
  if (nota.trim() === '') { delete notas[numero]; } else { notas[numero] = nota; }
  guardarNota(numero);
  console.log('Nota guardada para ' + numero);
  res.json({ ok: true });
});

// Borra por completo el historial de un número (conversación, pausa, seguimiento,
// nota). Pensado para que Lili resetee su propia conversación de prueba y vuelva
// a ver el flujo completo (saludo + fotos) cuando ensaya cambios en Olivia.
// Reabre un lead cerrado (venta o perdido) — lo pasa a pausado bajo control
// de Lili para que pueda retomar la conversación desde el panel.
app.post('/panel/reabrir', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.json({ ok: false });

  // Borrar el estado de cerrado y pausar para que quede en "Atendiendo yo"
  borrarSeguimiento(numero);
  marcarPausado(numero);
  console.log('Lead reabierto desde panel: ' + numero + ' — pasó a Atendiendo yo');
  res.json({ ok: true });
});

app.post('/panel/borrar-historial', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numero = (req.body.numero || '').replace(/[+\s-]/g, '');
  if (!esNumeroValido(numero)) return res.json({ ok: false });

  borrarHistorialCompleto(numero).then(function() {
    console.log('Historial borrado completamente para ' + numero);
    res.json({ ok: true });
  });
});

// Reactivación manual en tanda de leads fríos (sin actividad hace 5+ días).
app.post('/panel/reactivar-tanda', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false });
  var numeros = req.body.numeros;
  var mensaje = (req.body.mensaje || '').trim();
  if (!Array.isArray(numeros) || numeros.length === 0 || !mensaje) return res.json({ ok: false });

  var numerosLimpios = numeros
    .map(function(n) { return String(n).replace(/[+\s-]/g, ''); })
    .filter(esNumeroValido);

  if (numerosLimpios.length === 0) return res.json({ ok: false });

  numerosLimpios.forEach(function(numero, idx) {
    setTimeout(function() {
      marcarPausado(numero);
      agregarMensaje(numero, 'assistant', mensaje);
      cancelarSeguimiento(numero);
      enviarMensaje(numero, mensaje);
      console.log('Reactivación manual enviada a ' + numero);
    }, idx * 3000);
  });

  console.log('Tanda de reactivación iniciada: ' + numerosLimpios.length + ' leads');
  res.json({ ok: true, enviados: numerosLimpios.length });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1A, PASO 9 (22 jul) — registro de mensaje manual de Lili.
//
// Hallazgo del informe de Fase 0: los mensajes que Lili escribe manualmente
// desde la app de WhatsApp Business NO llegan a este backend (no hay forma
// de interceptarlos por webhook). Este endpoint NO resuelve esa limitación
// técnica — es un registro manual: Lili (u otra persona con el panel)
// escribe aquí lo que YA respondió por otro canal, para que quede en la
// línea de tiempo de `messages` y Olivia no pierda contexto ni vuelva a
// escribirle a un lead que Lili ya atendió.
//
// A propósito, en esta primera versión:
//   - NO envía nada por WhatsApp (Bearer/Graph API) — es solo un registro.
//   - Sí pausa a Olivia para ese lead, igual que hace /panel/enviar cuando
//     Lili responde de verdad desde el panel (mismo criterio, mismo
//     marcarPausado(), misma protección de LILI_NUMERO incluida gratis).
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/leads/:leadId/manual-message', function(req, res) {
  if (!tokenValido(req.body.token, CONTROL_TOKEN)) return res.status(403).json({ ok: false, error: 'No autorizado' });

  var leadId = parseInt(req.params.leadId, 10);
  var texto = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  var nota = typeof req.body.internal_note === 'string' && req.body.internal_note.trim() ? req.body.internal_note.trim() : null;

  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ ok: false, error: 'leadId inválido' });
  if (!texto) return res.status(400).json({ ok: false, error: 'text es requerido' });

  var occurredAt = new Date();
  if (req.body.occurred_at) {
    var fechaProvista = new Date(req.body.occurred_at);
    if (!isNaN(fechaProvista.getTime())) occurredAt = fechaProvista;
  }

  pool.query('SELECT * FROM leads WHERE id = $1', [leadId]).then(function(r) {
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });
    var lead = r.rows[0];

    return pool.query(
      'INSERT INTO messages (lead_id, whatsapp_message_id, direction, sender_type, message_type, text_content, raw_payload, occurred_at) ' +
      'VALUES ($1, NULL, $2, $3, $4, $5, $6, $7) RETURNING id',
      [
        lead.id, 'OUTBOUND', 'LILI', 'text', texto,
        JSON.stringify({ registrado_manualmente: true, internal_note: nota }),
        occurredAt
      ]
    ).then(function(insertRes) {
      var mensajeId = insertRes.rows[0].id;

      return pool.query(
        "UPDATE leads SET owner = 'LILI', olivia_enabled = false, last_business_message_at = NOW(), updated_at = NOW() WHERE id = $1",
        [lead.id]
      ).then(function() {
        registrarEventoLead(lead.id, 'MANUAL_MESSAGE_RECORDED', {
          actor: 'LILI',
          source: 'panel',
          metadata: { via: 'panel_manual_endpoint', internal_note: nota }
        });

        // Mantiene sincronizado el sistema legacy: sin esto, `pausados[numero]`
        // seguiría vacío y Olivia le seguiría respondiendo automáticamente a
        // un lead que Lili ya atendió por otro canal. marcarPausado() ya trae
        // su propia protección de LILI_NUMERO incluida.
        marcarPausado(lead.whatsapp_phone);

        console.log('📝 Mensaje manual registrado para lead ' + lead.whatsapp_phone + ' (id=' + lead.id + ')');
        res.json({ ok: true, messageId: mensajeId });
      });
    });
  }).catch(function(e) {
    console.error('Error registrando mensaje manual para lead ' + leadId + ':', e.message);
    res.status(500).json({ ok: false, error: 'Error interno' });
  });
});

function escapeHtml(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1A (22 jul) — CAPA DE COMPATIBILIDAD DEL CRM (leads / messages /
// lead_events). Todo lo de esta sección corre EN PARALELO al sistema legacy
// (conversaciones/pausados/seguimientos/notas) sin sustituirlo ni alterar su
// comportamiento. Nada aquí bloquea ni retrasa el flujo existente: son
// escrituras adicionales, best-effort, con manejo de error que solo loguea.
// ═══════════════════════════════════════════════════════════════════════════

// Mapea el estado legacy de seguimientos al lifecycle_stage de leads.
// No se borran ni renombran los estados antiguos — este mapa es de solo lectura.
const MAPA_LIFECYCLE_STAGE = {
  saludo_sin_respuesta: 'CONTACTED',
  esperando_info: 'WAITING_CUSTOMER_INFO',
  esperando_decision: 'WAITING_DECISION',
  cotizacion_enviada: 'QUOTED',
  cerrado_venta: 'WON',
  cerrado_perdido: 'LOST',
  cerrado_sin_respuesta: 'DORMANT'
};

// owner/olivia_enabled iniciales, derivados del estado legacy de `pausados`
// en el momento de creación del lead (mapeo sugerido en la Fase 1A).
function mapearEstadoInicialLead(numero) {
  var estaPausado = !!pausados[numero];
  return {
    owner: estaPausado ? 'LILI' : 'OLIVIA',
    oliviaEnabled: !estaPausado
  };
}

function registrarEventoLead(leadId, eventType, opts) {
  opts = opts || {};
  return pool.query(
    'INSERT INTO lead_events (lead_id, event_type, actor, source, metadata, whatsapp_message_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [leadId, eventType, opts.actor || null, opts.source || null, JSON.stringify(opts.metadata || {}), opts.whatsappMessageId || null]
  ).catch(function(e) {
    console.error('Error registrando evento ' + eventType + ' (lead ' + leadId + '):', e.message);
  });
}

// Busca un lead por whatsapp_phone; si no existe, lo crea de forma atómica
// (INSERT ... ON CONFLICT DO NOTHING + re-SELECT si perdió la carrera contra
// otra petición concurrente para el mismo número). Creación perezosa: no hay
// backfill de números que ya existan en `conversaciones`.
async function obtenerOCrearLead(numero) {
  var existente = await pool.query('SELECT * FROM leads WHERE whatsapp_phone = $1', [numero]);
  if (existente.rows.length > 0) {
    console.log('🔎 Lead encontrado: ' + numero + ' (id=' + existente.rows[0].id + ')');
    return { lead: existente.rows[0], creado: false };
  }

  var estadoInicial = mapearEstadoInicialLead(numero);
  var seg = seguimientos[numero];
  var lifecycleStage = (seg && MAPA_LIFECYCLE_STAGE[seg.estado]) ? MAPA_LIFECYCLE_STAGE[seg.estado] : 'NEW';

  var insertado = await pool.query(
    'INSERT INTO leads (whatsapp_phone, owner, olivia_enabled, lifecycle_stage, first_contact_at) ' +
    'VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (whatsapp_phone) DO NOTHING RETURNING *',
    [numero, estadoInicial.owner, estadoInicial.oliviaEnabled, lifecycleStage]
  );
  if (insertado.rows.length > 0) {
    var nuevoLead = insertado.rows[0];
    registrarEventoLead(nuevoLead.id, 'LEAD_CREATED', { actor: 'SYSTEM', source: 'webhook' });
    console.log('🆕 Lead creado: ' + numero + ' (id=' + nuevoLead.id + ', owner=' + estadoInicial.owner + ', stage=' + lifecycleStage + ')');
    return { lead: nuevoLead, creado: true };
  }

  // Perdió la carrera contra otra petición concurrente: el lead ya existe, lo recuperamos.
  var reintento = await pool.query('SELECT * FROM leads WHERE whatsapp_phone = $1', [numero]);
  console.log('🔎 Lead encontrado (tras perder carrera de creación): ' + numero + ' (id=' + reintento.rows[0].id + ')');
  return { lead: reintento.rows[0], creado: false };
}

function guardarMensajeEnTabla(leadId, opts) {
  return pool.query(
    'INSERT INTO messages (lead_id, whatsapp_message_id, direction, sender_type, message_type, text_content, media_id, raw_payload, occurred_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (whatsapp_message_id) DO NOTHING RETURNING id',
    [
      leadId,
      opts.whatsappMessageId || null,
      opts.direction,
      opts.senderType,
      opts.messageType || null,
      opts.textContent || null,
      opts.mediaId || null,
      JSON.stringify(opts.rawPayload || {}),
      opts.occurredAt || new Date()
    ]
  );
}

function actualizarTimestampLead(leadId, columna) {
  // columna solo puede ser uno de estos dos valores fijos — nunca viene del payload externo.
  var col = columna === 'last_business_message_at' ? 'last_business_message_at' : 'last_customer_message_at';
  return pool.query(
    'UPDATE leads SET ' + col + ' = NOW(), updated_at = NOW() WHERE id = $1',
    [leadId]
  ).catch(function(e) {
    console.error('Error actualizando ' + col + ' del lead ' + leadId + ':', e.message);
  });
}

// Punto de entrada único que usa el webhook para capturar un mensaje en el
// CRM nuevo (leads + messages + lead_events), sin tocar en ningún momento
// `conversaciones`, `agregarMensaje`, ni el flujo que le llega a Claude.
// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1A, PASO 5 (22 jul) — idempotencia real por whatsapp_message_id.
//
// El INSERT ... ON CONFLICT (whatsapp_message_id) DO NOTHING de
// guardarMensajeEnTabla() ES la protección real contra condiciones de
// carrera: si dos entregas del mismo webhook llegan casi al mismo tiempo,
// solo una gana el INSERT — un SELECT previo por separado dejaría una
// ventana de carrera entre el SELECT y el INSERT. Por eso este helper NO
// hace un SELECT de verificación aparte; usa el resultado del propio INSERT
// como señal de "¿ya existía?".
//
// El llamador (el webhook) debe esperar esta promesa y usar `duplicado`
// para decidir si sigue el flujo normal (Claude, envío, Telegram, seguimiento)
// o lo corta ahí. Esto reemplaza la dependencia exclusiva del lock en
// memoria `procesando[from]`, que no sobrevive un reinicio ni cubre reintentos
// de Meta después de que `procesando[from]` ya se liberó.
//
// Fail-open: si la BD falla (verificando o guardando), NO se bloquea el
// flujo comercial — Olivia debe seguir respondiendo aunque el tracking
// nuevo falle. Se devuelve duplicado:false, error:true para que el
// llamador trate el mensaje como nuevo y continúe como hoy.
// ═══════════════════════════════════════════════════════════════════════════
function capturarMensajeCRM(numero, opts) {
  return obtenerOCrearLead(numero).then(function(resultado) {
    var lead = resultado.lead;
    return guardarMensajeEnTabla(lead.id, opts).then(function(res) {
      if (res.rows.length === 0) {
        // ON CONFLICT no insertó nada → whatsapp_message_id ya existía: duplicado real.
        console.log('⏭️ Webhook duplicado ignorado (whatsapp_message_id ya procesado): ' + opts.whatsappMessageId);
        registrarEventoLead(lead.id, 'DUPLICATE_WEBHOOK_IGNORED', {
          actor: 'SYSTEM',
          source: 'webhook',
          whatsappMessageId: opts.whatsappMessageId
        });
        return { duplicado: true, lead: lead, mensajeId: null, error: false };
      }
      var mensajeId = res.rows[0].id;
      var eventType = opts.direction === 'INBOUND' ? 'MESSAGE_RECEIVED' : 'MESSAGE_SENT_BY_OLIVIA';
      if (opts.senderType === 'LILI') eventType = 'MANUAL_MESSAGE_RECORDED';
      var metadataEvento = { message_type: opts.messageType };
      if (opts.metadataExtra) {
        Object.keys(opts.metadataExtra).forEach(function(k) { metadataEvento[k] = opts.metadataExtra[k]; });
      }
      registrarEventoLead(lead.id, eventType, {
        actor: opts.senderType,
        source: 'webhook',
        whatsappMessageId: opts.whatsappMessageId,
        metadata: metadataEvento
      });
      actualizarTimestampLead(lead.id, opts.direction === 'INBOUND' ? 'last_customer_message_at' : 'last_business_message_at');
      return { duplicado: false, lead: lead, mensajeId: mensajeId, error: false };
    });
  }).catch(function(e) {
    console.error('⚠️ Error de BD verificando/guardando mensaje en CRM para ' + numero + ' — se continúa el flujo normal (fail-open):', e.message);
    return { duplicado: false, lead: null, mensajeId: null, error: true };
  });
}

// Actualiza el text_content de un mensaje ya guardado en el CRM (usado
// cuando la URL real de un archivo multimedia llega después del INSERT
// inicial). No falla el flujo si mensajeId es null (mensaje duplicado o
// error previo al capturar).
function actualizarTextoMensajeCRM(mensajeId, textoNuevo) {
  if (!mensajeId) return Promise.resolve();
  return pool.query('UPDATE messages SET text_content = $1 WHERE id = $2', [textoNuevo, mensajeId])
    .catch(function(e) { console.error('Error actualizando texto de mensaje CRM ' + mensajeId + ':', e.message); });
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1A, PASO 6 (22 jul) — captura de `message.referral` (Click-to-
// WhatsApp Ads). Meta lo manda embebido dentro del mismo mensaje entrante
// cuando el lead escribió por primera vez tras hacer clic en un anuncio —
// no es un webhook aparte. No todos los campos llegan siempre; nunca se
// asume su presencia y nunca se sobreescribe un valor ya confirmado con null.
// ═══════════════════════════════════════════════════════════════════════════
const CAMPOS_REFERRAL_CONOCIDOS = [
  'source_url', 'source_type', 'source_id', 'headline', 'body', 'media_type',
  'image_url', 'video_url', 'thumbnail_url', 'ctwa_clid', 'ad_id', 'campaign_id', 'adset_id'
];

// Se queda solo con las claves conocidas que realmente vinieron con valor
// (nunca null/undefined/''), para que el merge en la BD no pueda borrar
// un dato ya confirmado en un evento anterior.
function extraerCamposReferralPresentes(referralRaw) {
  var presentes = {};
  CAMPOS_REFERRAL_CONOCIDOS.forEach(function(campo) {
    var valor = referralRaw[campo];
    if (valor !== undefined && valor !== null && valor !== '') presentes[campo] = valor;
  });
  return presentes;
}

function capturarReferral(lead, referralRaw, whatsappMessageId) {
  if (!lead || !referralRaw || typeof referralRaw !== 'object') return;

  var presentes = extraerCamposReferralPresentes(referralRaw);
  var claves = Object.keys(presentes);

  // Log sanitizado: solo nombres de claves y a qué lead se asoció — nunca
  // se loguea nada que pudiera ser un token o credencial (este objeto nunca
  // los trae; son datos de campaña/anuncio, no secretos de la API).
  console.log('📎 Referral recibido — lead=' + lead.whatsapp_phone + ' (id=' + lead.id + '), claves presentes: ' +
    (claves.length ? claves.join(', ') : '(ninguna de las conocidas)'));

  pool.query(
    'UPDATE leads SET ' +
    'referral_data = referral_data || $2::jsonb, ' +
    'campaign_id = COALESCE($3, campaign_id), ' +
    'adset_id = COALESCE($4, adset_id), ' +
    'ad_id = COALESCE($5, ad_id), ' +
    "source = COALESCE(NULLIF(source, ''), 'ctwa_referral'), " +
    'updated_at = NOW() ' +
    'WHERE id = $1',
    [lead.id, JSON.stringify(presentes), presentes.campaign_id || null, presentes.adset_id || null, presentes.ad_id || null]
  ).then(function() {
    registrarEventoLead(lead.id, 'REFERRAL_CAPTURED', {
      actor: 'SYSTEM',
      source: 'webhook',
      whatsappMessageId: whatsappMessageId,
      metadata: presentes
    });
  }).catch(function(e) {
    console.error('Error guardando referral del lead ' + lead.id + ':', e.message);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1A, PASO 7 (22 jul) — eventos `leadgen` de Meta Lead Ads.
//
// 🔄 ACTUALIZACIÓN (22 jul 2026) — PARCIALMENTE ACTIVO, AÚN SIN VERIFICAR DEL
// TODO. Lili ya agregó el producto Lead Ads y activó la suscripción al campo
// de webhook `leadgen` en el Meta App Dashboard (confirmado por Meta: "Se
// suscribió correctamente al campo del webhook leadgen v25.0"). Con esto,
// el punto 1 de la lista original de abajo YA quedó resuelto.
//
// Quedan DOS cosas más sin confirmar antes de que un lead de prueba real
// funcione de punta a punta — si alguna falta, el evento puede no llegar
// aquí, o llegar pero fallar en la llamada a Graph API (ver el try/catch de
// manejarEventoLeadgen, que ya deja el error visible en logs y en
// lead_form_submissions.estado_vinculacion = 'FALLIDO' de todas formas):
//
//   A. La PÁGINA de Facebook específica (la que corre los anuncios de Lead
//      Ads) debe estar suscrita a ESTA app — esto es independiente de la
//      suscripción a nivel de app que ya se hizo. Se verifica/activa desde
//      Meta Business Suite (configuración de Lead Ads/Instant Forms de la
//      página) o con `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`
//      usando un token de página. Si esto falta, el evento webhook nunca
//      llega — ni siquiera se vería un error, simplemente no pasaría nada.
//
//   B. RESUELTO por ETAPA 0 (3 ago 2026, ver banner más abajo): META_API_TOKEN
//      es un User Token y NUNCA tuvo permiso leads_retrieval sobre me/leadgen_forms
//      ni {leadgen_id}. Confirmado a mano en Graph API Explorer que un Page
//      Access Token (derivado de me/accounts con permiso pages_manage_ads) sí
//      funciona. `manejarEventoLeadgen()` ahora usa `pageAccessToken` en vez
//      de META_API_TOKEN para esta llamada.
//
// Recomendación antes de generar un lead de prueba con la herramienta de
// Lead Ads Testing: confirmar A primero. Si no se confirma, igual se puede
// generar el lead de prueba — el resultado en los logs/tabla dirá si ese
// paso falta (o si ya está completo).
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 ETAPA 0 (3 ago 2026) — Page Access Token para la Graph API de Lead Ads.
//
// manejarEventoLeadgen() fallaba al leer leads porque usaba META_API_TOKEN
// (un User Token) contra endpoints que requieren un Page Access Token con
// permiso leads_retrieval. Confirmado a mano en Graph API Explorer: User
// Token + pages_manage_ads → me/accounts?fields=id,name,access_token →
// Page Access Token de "Hecho por Lili" → funciona en me/leadgen_forms y en
// {form_id}/leads.
//
// obtenerPageAccessToken() deriva ese token al arranque del servidor. El
// token corto de me/accounts dura ~1h, así que se extiende de inmediato a
// larga duración (60 días, o indefinido si la página ya dio permisos
// permanentes) con el flujo fb_exchange_token — requiere META_APP_SECRET
// (ya existe en el código para verificar la firma del webhook, línea ~20;
// confirmar que esté configurado en Railway) y META_APP_ID. Si la extensión
// falla, se usa igual el token corto (mejor 1h que nada) con una advertencia
// clara en logs — nunca bloquea el arranque del resto del servidor.
// ═══════════════════════════════════════════════════════════════════════════

// Intercambia un Page Access Token de corta duración (~1h, el que devuelve
// me/accounts) por uno de larga duración (60 días o indefinido). Lanza si
// falla — quien llama decide el fallback.
async function extenderPageAccessToken(tokenCorto) {
  if (!META_APP_SECRET) {
    throw new Error('META_APP_SECRET no está configurado en las variables de entorno');
  }
  var resp = await axios.get('https://graph.facebook.com/v25.0/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: tokenCorto
    }
  });
  return resp.data.access_token;
}

// Deriva el Page Access Token al arranque del servidor y lo guarda en
// `pageAccessToken` (variable de módulo). Nunca relanza el error — un fallo
// aquí se loguea y Olivia sigue funcionando para WhatsApp de todas formas
// (ver banner arriba).
async function obtenerPageAccessToken() {
  try {
    var resp = await axios.get('https://graph.facebook.com/v25.0/me/accounts', {
      params: { fields: 'id,name,access_token' },
      headers: { Authorization: 'Bearer ' + META_API_TOKEN }
    });
    var paginas = resp.data.data || [];
    if (paginas.length === 0) {
      throw new Error('me/accounts no devolvió ninguna página');
    }
    var pagina = paginas.find(function(p) { return p.name === 'Hecho por Lili'; }) || paginas[0];

    try {
      pageAccessToken = await extenderPageAccessToken(pagina.access_token);
      console.log('✅ Page Access Token obtenido para ' + pagina.name);
    } catch (eExtender) {
      pageAccessToken = pagina.access_token;
      var detalleExtender = eExtender.response ? (eExtender.response.status + ' ' + JSON.stringify(eExtender.response.data)) : eExtender.message;
      console.warn('⚠️ Page Token es de corta duración, expirará en ~1h — no se pudo extender a larga duración: ' + detalleExtender);
      console.log('✅ Page Access Token obtenido para ' + pagina.name);
    }
  } catch (e) {
    var detalle = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data)) : e.message;
    console.error('❌ No se pudo obtener Page Access Token: ' + detalle);

    // 🆕 FIX RÁPIDO (3 ago): si la derivación automática falla (ej.
    // META_API_TOKEN sin permiso para listar páginas), usar un Page Access
    // Token puesto a mano en Railway como fallback, sin tocar META_API_TOKEN.
    if (PAGE_ACCESS_TOKEN_ENV) {
      pageAccessToken = PAGE_ACCESS_TOKEN_ENV;
      console.log('📋 Usando PAGE_ACCESS_TOKEN de variable de entorno (no derivado)');
    }
  }
}

const CAMPOS_TELEFONO_FORMULARIO = [
  'phone_number', 'phone', 'telefono', 'teléfono', 'whatsapp',
  'numero_whatsapp', 'número_whatsapp', 'celular', 'numero_celular', 'número_celular'
];

// Busca, entre las respuestas del formulario (field_data de la Graph API),
// una que parezca un número de teléfono reconocible. Nunca "adivina" — si
// no hay un campo con nombre reconocible y un valor que pase esNumeroValido
// tras limpiar el formato, devuelve null y la vinculación queda pendiente.
function extraerTelefonoDeFieldData(fieldData) {
  if (!Array.isArray(fieldData)) return null;
  for (var i = 0; i < fieldData.length; i++) {
    var campo = fieldData[i];
    if (!campo || !campo.name || !Array.isArray(campo.values) || !campo.values[0]) continue;
    var nombreNormalizado = String(campo.name).toLowerCase().trim();
    if (CAMPOS_TELEFONO_FORMULARIO.indexOf(nombreNormalizado) === -1) continue;
    var soloDigitos = String(campo.values[0]).replace(/\D/g, '');
    if (esNumeroValido(soloDigitos)) return soloDigitos;
  }
  return null;
}

async function manejarEventoLeadgen(value) {
  var leadgenId = value.leadgen_id;
  var formId = value.form_id || null;
  var pageId = value.page_id || null;
  var adId = value.ad_id || null;
  var adgroupId = value.adgroup_id || null;

  if (!leadgenId) {
    console.error('Evento leadgen sin leadgen_id — payload inesperado, se ignora');
    return;
  }

  // Log sanitizado (instrumentación de la sección 7): solo IDs de campaña/
  // formulario, nunca contenido de las respuestas.
  console.log('📋 Evento leadgen recibido — object=page, field=leadgen, leadgen_id=' + leadgenId +
    ', form_id=' + formId + ', ad_id=' + adId + ', page_id=' + pageId);

  // Idempotencia igual que con whatsapp_message_id: el propio INSERT ...
  // ON CONFLICT DO NOTHING es la protección real contra reentregas/carreras.
  var insertado = await pool.query(
    'INSERT INTO lead_form_submissions (leadgen_id, page_id, form_id, ad_id, adgroup_id, estado_vinculacion) ' +
    "VALUES ($1, $2, $3, $4, $5, 'PENDIENTE') ON CONFLICT (leadgen_id) DO NOTHING RETURNING id",
    [leadgenId, pageId, formId, adId, adgroupId]
  );
  if (insertado.rows.length === 0) {
    console.log('⏭️ Evento leadgen duplicado ignorado: ' + leadgenId);
    registrarEventoLead(null, 'DUPLICATE_WEBHOOK_IGNORED', {
      actor: 'SYSTEM',
      source: 'leadgen_webhook',
      metadata: { leadgen_id: leadgenId }
    });
    return;
  }
  var submissionId = insertado.rows[0].id;

  registrarEventoLead(null, 'LEAD_FORM_WEBHOOK_RECEIVED', {
    actor: 'SYSTEM',
    source: 'leadgen_webhook',
    metadata: { leadgen_id: leadgenId, form_id: formId, ad_id: adId, page_id: pageId }
  });

  // 🆕 ETAPA 0: usa pageAccessToken (derivado al arranque, ver
  // obtenerPageAccessToken()), no META_API_TOKEN — este último es un User
  // Token sin permiso leads_retrieval sobre este endpoint. Si la derivación
  // falló al arrancar, pageAccessToken sigue en null y esta llamada fallará
  // con un error de autenticación — visible en logs y en
  // lead_form_submissions.estado_vinculacion = 'FALLIDO', igual que
  // cualquier otro fallo de Graph API (catch de abajo).
  try {
    var resp = await axios.get(
      'https://graph.facebook.com/v21.0/' + leadgenId,
      {
        params: { fields: 'field_data' },
        headers: { Authorization: 'Bearer ' + pageAccessToken }
      }
    );
    var fieldData = resp.data.field_data || [];

    await pool.query(
      'UPDATE lead_form_submissions SET field_data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(fieldData), submissionId]
    );
    registrarEventoLead(null, 'LEAD_FORM_DATA_RETRIEVED', {
      actor: 'SYSTEM',
      source: 'leadgen_webhook',
      metadata: { leadgen_id: leadgenId, campos_recibidos: fieldData.map(function(f) { return f.name; }) }
    });

    var telefono = extraerTelefonoDeFieldData(fieldData);
    if (telefono) {
      var resultadoLead = await obtenerOCrearLead(telefono);
      var leadVinculado = resultadoLead.lead;

      await pool.query(
        'UPDATE lead_form_submissions SET lead_id = $1, estado_vinculacion = \'VINCULADO\', updated_at = NOW() WHERE id = $2',
        [leadVinculado.id, submissionId]
      );
      await pool.query(
        'UPDATE leads SET lead_form_data = lead_form_data || $2::jsonb, form_id = COALESCE($3, form_id), ad_id = COALESCE($4, ad_id), updated_at = NOW() WHERE id = $1',
        [leadVinculado.id, JSON.stringify({ leadgen_id: leadgenId, field_data: fieldData }), formId, adId]
      );
      registrarEventoLead(leadVinculado.id, 'LEAD_FORM_LINKED_TO_WHATSAPP', {
        actor: 'SYSTEM',
        source: 'leadgen_webhook',
        metadata: { leadgen_id: leadgenId }
      });
      console.log('🔗 Formulario vinculado a WhatsApp — leadgen_id=' + leadgenId + ' → lead_id=' + leadVinculado.id);

      // 🆕 Etapa 2, punto 2 (3 ago 2026) — intención de compra declarada en
      // el formulario, persistida para usarse más adelante en
      // procesarMensaje() cuando se active el primer saludo_sin_respuesta
      // (ver VENTANA_REACTIVACION_POR_INTENCION). "inmediatamente" además
      // dispara una alerta a Lili YA, sin esperar a que el saludo quede sin
      // respuesta — es la única categoría que pide atención prioritaria.
      // Aislado en su propio try/catch: un fallo aquí NUNCA debe revertir
      // la vinculación que ya quedó exitosa arriba (estado_vinculacion ya
      // es 'VINCULADO' — este paso es un enriquecimiento adicional, no una
      // condición para el éxito de la vinculación).
      try {
        var nivelIntencion = detectarIntencionCompraFormulario(fieldData);
        if (nivelIntencion) {
          await pool.query('UPDATE leads SET buy_intent = $2, updated_at = NOW() WHERE id = $1', [leadVinculado.id, nivelIntencion]);
          console.log('🎯 Intención de compra detectada para lead ' + leadVinculado.id + ': ' + nivelIntencion);
          if (nivelIntencion === 'inmediatamente') {
            notificarLili(telefono, 'Este lead marcó "inmediatamente" en el formulario — quiere comprar ya. Prioriza este chat.');
          }
        }
      } catch (eIntencion) {
        console.error('Error guardando intención de compra para lead ' + leadVinculado.id + ':', eIntencion.message);
      }
    } else {
      await pool.query(
        'UPDATE lead_form_submissions SET estado_vinculacion = \'FALLIDO\', updated_at = NOW() WHERE id = $1',
        [submissionId]
      );
      registrarEventoLead(null, 'LEAD_FORM_LINK_FAILED', {
        actor: 'SYSTEM',
        source: 'leadgen_webhook',
        metadata: { leadgen_id: leadgenId, razon: 'sin_campo_telefono_reconocible' }
      });
      console.log('⚠️ No se pudo vincular el formulario a WhatsApp (leadgen_id=' + leadgenId + ') — sin campo de teléfono reconocible. Queda como lead externo pendiente de vinculación.');
    }
  } catch (e) {
    var detalleError = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data)) : e.message;
    console.error('❌ Error consultando Graph API para leadgen_id=' + leadgenId + ' (probablemente el producto Lead Ads todavía no está activo en el Meta App Dashboard):', detalleError);
    await pool.query(
      'UPDATE lead_form_submissions SET estado_vinculacion = \'FALLIDO\', updated_at = NOW() WHERE id = $1',
      [submissionId]
    ).catch(function() {});
    registrarEventoLead(null, 'LEAD_FORM_LINK_FAILED', {
      actor: 'SYSTEM',
      source: 'leadgen_webhook',
      metadata: { leadgen_id: leadgenId, razon: 'graph_api_error' }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 1B (23 jul) — Olivia usa las respuestas de los 3 formularios de
// Lead Ads (Repisa, Mesa Auxiliar, Escritorio) para personalizar su primer
// mensaje, en vez de repetir el saludo largo que Meta ya muestra en el
// propio formulario. Ver whatsapp_agent.js:procesarMensaje() para dónde se
// usa esto.
// ═══════════════════════════════════════════════════════════════════════════

// Busca, para un lead dado, el formulario de Lead Ads vinculado más
// reciente — solo si quedó VINCULADO (nunca PENDIENTE/FALLIDO) y dentro de
// una ventana de 48h desde que llegó el evento leadgen. Fuera de esa
// ventana se asume que el contexto ya no es relevante para un saludo
// personalizado (decisión de Lili: "el ciclo de decisión puede tomar unos días").
async function obtenerFormularioVinculadoReciente(leadId) {
  if (!leadId) return null;
  var r = await pool.query(
    "SELECT * FROM lead_form_submissions WHERE lead_id = $1 AND estado_vinculacion = 'VINCULADO' " +
    "AND created_at >= NOW() - INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1",
    [leadId]
  );
  return r.rows.length > 0 ? r.rows[0] : null;
}

// Mejor esfuerzo para detectar a qué producto pertenece un formulario o
// anuncio, buscando palabras clave. Las claves deben identificar el
// producto sin ambigüedad — ver bug real del 27 jul: 'versión', 'compacta',
// 'clásica' eran palabras de la opción de Mesa Auxiliar pero también
// podían aparecer en el copy de OTRO anuncio (Escritorio Flotante),
// causando un falso positivo porque detectarProductoPorTexto() evalúa
// productos en orden y Mesa Auxiliar va antes que Escritorio en esta
// lista. Quitadas; solo quedan claves que nombran el producto explícitamente.
// ⚠️ Los nombres exactos de campo de formulario no se han visto todavía en
// un payload real (ver docs/PHASE_1B_PLAN.md). Si no logra detectar el
// producto, no rompe nada: simplemente no incluye el nombre del producto
// en el encabezado, y Claude sigue teniendo las respuestas/el anuncio
// crudos como contexto.
const CLAVES_PRODUCTO_FORMULARIO = [
  { producto: 'Repisa Flotante', claves: ['repisa'] },
  { producto: 'Mesa Auxiliar', claves: ['mesa auxiliar', 'mesa_auxiliar'] },
  { producto: 'Escritorio Flotante', claves: ['escritorio'] }
];

// 🆕 AJUSTE 1 (23 jul) — núcleo compartido de detección de producto por
// palabras clave. Antes vivía solo dentro de detectarProductoFormulario();
// se extrajo para que detectarProductoDesdeReferral() (más abajo) reutilice
// la MISMA lista de palabras clave, en vez de duplicarla.
function detectarProductoPorTexto(textos) {
  var texto = textos.filter(Boolean).join(' ').toLowerCase();
  for (var i = 0; i < CLAVES_PRODUCTO_FORMULARIO.length; i++) {
    var item = CLAVES_PRODUCTO_FORMULARIO[i];
    for (var j = 0; j < item.claves.length; j++) {
      if (texto.indexOf(item.claves[j]) !== -1) return item.producto;
    }
  }
  return null;
}

// 🆕 (27 jul) — dos pasadas: primero solo por `name` (la pregunta, más
// estable como identificador del formulario) y solo si eso no encuentra
// nada, cae al comportamiento anterior (`name` + `values` combinados) como
// respaldo. Evita que un `name` genérico gane por casualidad frente a un
// `value` que sí nombra el producto explícitamente, sin perder la
// detección de hoy para formularios cuyo `name` no sea informativo.
function detectarProductoFormulario(fieldData) {
  if (!Array.isArray(fieldData)) return null;

  var nombres = fieldData.map(function(campo) { return campo.name || ''; });
  var porNombre = detectarProductoPorTexto(nombres);
  if (porNombre) return porNombre;

  var textos = fieldData.map(function(campo) {
    var valores = Array.isArray(campo.values) ? campo.values.join(' ') : '';
    return (campo.name || '') + ' ' + valores;
  });
  return detectarProductoPorTexto(textos);
}

// 🆕 Etapa 2, punto 2 (3 ago 2026) — cadencia de seguimiento según la
// intención de compra declarada en el formulario. Campo y valores
// confirmados con datos reales (Lili, 3 ago 2026) — nombre exacto del
// campo `¿cuándo_te_gustaría_comprarla?`, 4 valores posibles. Nunca
// adivina: si el campo no está o el valor no es uno de los 4 conocidos,
// devuelve null (cadencia por defecto).
var NOMBRE_CAMPO_INTENCION_COMPRA = '¿cuándo_te_gustaría_comprarla?';
var NIVELES_INTENCION_COMPRA_VALIDOS = [
  'inmediatamente',
  'en_los_próximos_15_días',
  'durante_este_mes',
  'en_1_o_2_meses'
];

function detectarIntencionCompraFormulario(fieldData) {
  if (!Array.isArray(fieldData)) return null;
  for (var i = 0; i < fieldData.length; i++) {
    var campo = fieldData[i];
    if (!campo || !campo.name) continue;
    if (String(campo.name).toLowerCase().trim() !== NOMBRE_CAMPO_INTENCION_COMPRA) continue;
    var valor = Array.isArray(campo.values) && campo.values[0] ? String(campo.values[0]).toLowerCase().trim() : null;
    if (valor && NIVELES_INTENCION_COMPRA_VALIDOS.indexOf(valor) !== -1) return valor;
  }
  return null;
}

// Convierte field_data crudo (array de {name, values} de la Graph API) en
// un bloque de texto legible para el system prompt de Claude. Excluye
// nombre/teléfono (ya los tenemos como identidad del lead, no aportan
// contexto de producto). Devuelve null si no hay nada útil que mostrar.
function formatearRespuestasFormulario(submission) {
  var fieldData = submission.field_data;
  if (!Array.isArray(fieldData) || fieldData.length === 0) return null;

  var producto = detectarProductoFormulario(fieldData);
  var lineas = fieldData
    .filter(function(campo) { return campo.name !== 'phone_number' && campo.name !== 'full_name'; })
    .map(function(campo) {
      var valor = Array.isArray(campo.values) ? campo.values.join(', ') : String(campo.values || '');
      return '- ' + (campo.name || 'campo') + ': ' + valor;
    });

  if (lineas.length === 0) return null;

  var encabezado = producto ? ('Formulario respondido (' + producto + '):') : 'Formulario respondido:';
  return encabezado + '\n' + lineas.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 AJUSTE 1 (23 jul) — cuando un lead llega de un anuncio (referral de
// Click-to-WhatsApp) y escribe algo genérico sin nombrar el producto ni
// haber llenado el formulario, Olivia no debe preguntar "¿qué mueble te
// interesa?" — ya sabemos el producto por leads.referral_data. Mismo
// patrón que el formulario (Fase 1B), pero disparado por el referral.
//
// Detección por palabras clave en headline/body/source_url (Opción B del
// plan aprobado por Lili) en vez de una lista fija de ad_id — más robusto
// ante anuncios nuevos y no depende de conseguir IDs desde Meta (fricción
// ya vivida en sesiones anteriores). Reutiliza detectarProductoPorTexto(),
// la misma lista de palabras clave que ya usa el formulario.
// ═══════════════════════════════════════════════════════════════════════════
function detectarProductoDesdeReferral(referralData) {
  if (!referralData || typeof referralData !== 'object') return null;
  return detectarProductoPorTexto([referralData.headline, referralData.body, referralData.source_url]);
}

// Arma el bloque de contexto del anuncio para el system prompt. Devuelve
// null si no hay headline/body utilizable (no inventa nada).
function formatearContextoReferral(referralData, producto) {
  if (!referralData || typeof referralData !== 'object') return null;
  var partes = [];
  if (referralData.headline) partes.push('Titular del anuncio: ' + referralData.headline);
  if (referralData.body) partes.push('Texto del anuncio: ' + referralData.body);
  if (partes.length === 0) return null;

  var encabezado = producto ? ('Lead proveniente de un anuncio (' + producto + '):') : 'Lead proveniente de un anuncio:';
  return encabezado + '\n' + partes.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 🐛 FIX (26 jul) — condición de carrera confirmada con el lead real
// 573138910346 (id=11): capturarReferral() escribe referral_data a la BD
// de forma async/fire-and-forget y NUNCA muta el objeto `lead` en memoria.
// Cuando el referral llega en el MISMO mensaje que crea el lead (el caso
// típico de Click-to-WhatsApp), `resultadoCRM.lead.referral_data` en el
// webhook todavía está vacío en ese instante — la escritura a la BD y la
// lectura para armar el contexto de Claude corren en paralelo, y la
// lectura gana la carrera.
//
// Fix: usar `message.referral` del mensaje ACTUAL como fuente principal
// (disponible sincrónicamente, sin depender de la BD) con
// `referralGuardado` (de la BD) como respaldo para mensajes posteriores
// que ya no traen su propio referral. El actual tiene prioridad porque es
// el más fresco.
// ═══════════════════════════════════════════════════════════════════════════
function construirReferralParaContexto(referralGuardado, messageReferral) {
  var actual = messageReferral ? extraerCamposReferralPresentes(messageReferral) : {};
  var guardado = referralGuardado || {};
  return Object.assign({}, guardado, actual);
}

app.get('/webhook', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tokenValido(token, WEBHOOK_VERIFY_TOKEN)) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', function(req, res) {
  if (!firmaWebhookValida(req)) {
    console.error('Webhook rechazado: firma invalida o ausente');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    var entry = req.body.entry;
    if (!entry) return;
    var value = entry[0].changes[0].value;
    if (!value) return;

    // 🆕 FASE 1A, PASO 12 — log estructurado mínimo de "webhook recibido"
    // (sección 12 del prompt). Sanitizado: solo el tipo de objeto y, si viene,
    // el message_id — nunca el cuerpo completo del payload (podría incluir
    // texto del cliente o datos de formulario).
    console.log('📩 Webhook recibido — object=' + (req.body.object || 'desconocido') +
      (value.messages && value.messages[0] ? ', message_id=' + value.messages[0].id : '') +
      (value.leadgen_id ? ', leadgen_id=' + value.leadgen_id : ''));

    // 🆕 FASE 1A, PASO 7 — eventos leadgen (Meta Lead Ads) llegan al MISMO
    // webhook, distinguibles por req.body.object === 'page' y value.leadgen_id
    // (en vez de value.messages/value.statuses del objeto whatsapp_business_account).
    // Suscripción al campo `leadgen` YA ACTIVADA (22 jul 2026) — este bloque ya
    // puede recibir tráfico real. Ver el banner grande junto a
    // manejarEventoLeadgen() para lo que todavía falta confirmar (suscripción
    // de la página específica + permiso leads_retrieval) antes de que la
    // vinculación por Graph API funcione de punta a punta.
    if (req.body.object === 'page' && value.leadgen_id) {
      manejarEventoLeadgen(value).catch(function(e) {
        console.error('Error procesando evento leadgen:', e.message);
      });
      return;
    }

    // ANTES esto se ignoraba por completo. Meta manda aquí si un mensaje
    // realmente se entregó, se leyó, o FALLÓ (ej: ventana de 24h vencida).
    // Si un mensaje falla, lo registramos en consola Y le avisamos a Lili
    // por Telegram/WhatsApp, porque hasta ahora ese fallo quedaba invisible
    // — el panel decía "enviado" pero el lead nunca lo recibía.
    if (value.statuses) {
      value.statuses.forEach(function(st) {
        if (st.status === 'failed') {
          var numeroFallido = st.recipient_id || 'desconocido';
          var razonFallo = (st.errors && st.errors[0] && st.errors[0].title) || 'razón desconocida';
          console.error('⚠️ MENSAJE FALLÓ a ' + numeroFallido + ': ' + razonFallo);
          notificarLili(numeroFallido, 'Un mensaje NO se pudo entregar (' + razonFallo + '). Revisa este lead — puede que la ventana de 24h esté vencida o haya otro problema.');
        }
      });
      return;
    }

    if (value.messages) {
      var message = value.messages[0];
      var esSaliente = false;
      if (message.from && message.from === PHONE_NUMBER_ID) esSaliente = true;

      // 🆕 Rastreo de fallo silencioso (29 jul) — ninguno de los `if` de tipo
      // de mensaje de abajo tenía un `else`, así que un message.type no
      // contemplado (interactive, button, contacts, location, sticker,
      // reaction, order, system, unsupported...) o un `from` que no pasara
      // esNumeroValido caían entre todas las condiciones sin loguear nada y
      // sin lanzar ninguna excepción — el webhook terminaba en silencio
      // total después de "📩 Webhook recibido", sin tocar el try/catch de
      // más abajo porque nunca hubo error. Ver docs/PENDIENTES.md.
      //
      // 🆕 ETAPA 1 (3 ago 2026): antes de decidir si el mensaje se maneja,
      // se resuelve el número del remitente con la jerarquía from →
      // contacts.wa_id (ver resolverNumeroRemitente()) — no solo message.from.
      var numeroResuelto = resolverNumeroRemitente(message, value.contacts);
      var tipoDeMensajeManejado = tipoDeMensajeEsManejado(message, esSaliente, numeroResuelto);

      if (esSaliente && message.type === 'text') {
        var leadNumero = message.to || null;
        if (leadNumero && esNumeroValido(leadNumero)) {
          capturarMensajeCRM(leadNumero, {
            whatsappMessageId: message.id,
            direction: 'OUTBOUND',
            senderType: 'LILI',
            messageType: 'text',
            textContent: message.text.body,
            rawPayload: message,
            occurredAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
            metadataExtra: { via: 'whatsapp_webhook_outbound' }
          }).then(function(resultadoCRM) {
            if (resultadoCRM.duplicado) return; // ya procesado — no repetir pausa/seguimiento

            marcarPausado(leadNumero);
            console.log('Lili escribió a ' + leadNumero + ' — número pausado automáticamente');
            agregarMensaje(leadNumero, 'assistant', message.text.body);
            var estadoDetectado = detectarEstadoPorMensajeLili(message.text.body);
            if (estadoDetectado) {
              activarSeguimiento(leadNumero, estadoDetectado, resultadoCRM.lead ? resultadoCRM.lead.product : null);
              console.log('Estado seguimiento activado para ' + leadNumero + ': ' + estadoDetectado);
            }
          });
        }
        return;
      }

      if (message && message.type === 'text' && numeroResuelto) {
        var from = numeroResuelto;
        var texto = message.text.body;

        // 🆕 Lock síncrono contra condición de carrera (ver
        // reclamarLockProcesando() más arriba en el archivo para el
        // diagnóstico completo del caso real). Reclamado AQUÍ, antes de
        // capturarMensajeCRM() — no dentro de su .then() — para que un
        // segundo mensaje en ráfaga ya encuentre el lock tomado. Mejora
        // inmediata aprobada por Lili; la solución completa (cola/debounce
        // que agrupe mensajes en ráfaga y responda una sola vez) queda para
        // la siguiente iteración — mientras tanto, un segundo mensaje en
        // ráfaga se sigue guardando en el historial (ver dentro del .then
        // de abajo) pero no dispara respuesta en esa pasada: comportamiento
        // determinista y documentado, no un bug.
        var yaHabiaMensajeEnProceso = reclamarLockProcesando(from);

        capturarMensajeCRM(from, {
          whatsappMessageId: message.id,
          direction: 'INBOUND',
          senderType: 'CUSTOMER',
          messageType: 'text',
          textContent: texto,
          rawPayload: message,
          occurredAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date()
        }).then(function(resultadoCRM) {
          // Idempotencia real: si whatsapp_message_id ya existía en `messages`,
          // es un reintento/duplicado del webhook de Meta — no se vuelve a
          // ejecutar IA, no se reenvía, no se reactiva seguimiento. Si hubo un
          // error de BD verificando (resultadoCRM.error), se sigue el flujo
          // normal (fail-open) para no perder el mensaje del cliente.
          if (resultadoCRM.duplicado) {
            liberarLockSiLoReclamamos(from, yaHabiaMensajeEnProceso);
            return;
          }
          if (message.referral && resultadoCRM.lead) capturarReferral(resultadoCRM.lead, message.referral, message.id);

          console.log('Mensaje de ' + from + ' (message_id=' + message.id + '): ' + texto);
          agregarMensaje(from, 'user', texto);
          cancelarSeguimiento(from);

          if (leadPrometioInfo(texto) && !pausados[from]) {
            setTimeout(function() {
              if (!pausados[from]) { activarSeguimiento(from, 'esperando_info', resultadoCRM.lead ? resultadoCRM.lead.product : null); }
            }, 2000);
          }

          if (pausadoTodo) {
            console.log('Pausado global (mensaje guardado, agente no responde)');
            liberarLockSiLoReclamamos(from, yaHabiaMensajeEnProceso);
            return;
          }
          if (pausados[from]) {
            console.log('Numero pausado (mensaje guardado, agente no responde): ' + from);
            liberarLockSiLoReclamamos(from, yaHabiaMensajeEnProceso);
            return;
          }
          if (yaHabiaMensajeEnProceso) {
            // El lock ya estaba tomado por OTRO mensaje de este mismo número
            // (no lo reclamamos nosotros arriba) — no lo tocamos, es de esa
            // otra pasada. Este mensaje ya quedó guardado en el CRM/historial.
            console.log('Ya procesando mensaje de: ' + from);
            return;
          }

          // 🆕 FASE 1B: se pasa el leadId (si lo tenemos) para que procesarMensaje
          // pueda buscar un formulario de Lead Ads vinculado reciente.
          // 🆕 AJUSTE 1 + 🐛 FIX (26 jul): se pasa referral_data combinando lo
          // guardado en la BD con el referral de ESTE mismo mensaje (más fresco
          // — evita la condición de carrera con la escritura async de
          // capturarReferral(), ver construirReferralParaContexto()).
          var leadIdParaFormulario = resultadoCRM.lead ? resultadoCRM.lead.id : null;
          var referralDataParaContexto = resultadoCRM.lead
            ? construirReferralParaContexto(resultadoCRM.lead.referral_data, message.referral)
            : null;
          setTimeout(function() { procesarMensaje(from, texto, leadIdParaFormulario, referralDataParaContexto); }, 500);
        });
      }

      if (message && (message.type === 'image' || message.type === 'video' || message.type === 'audio' || message.type === 'document') && numeroResuelto) {
        var fromMedia = numeroResuelto;
        var mediaObj = message[message.type]; // message.image, message.audio, etc.
        var mediaId = mediaObj && mediaObj.id;
        var esVideoTipo = message.type === 'audio'; // Cloudinary guarda audio como "video"
        var textoMedia = '[El cliente envió ' + (message.type === 'image' ? 'una imagen' : message.type === 'audio' ? 'un audio' : 'un archivo') + ']';

        // 🆕 Lock síncrono contra condición de carrera — misma arquitectura y
        // mismo diagnóstico que la rama de texto entrante arriba (ver
        // reclamarLockProcesando() para el detalle completo del caso real).
        var yaHabiaMensajeEnProcesoMedia = reclamarLockProcesando(fromMedia);

        capturarMensajeCRM(fromMedia, {
          whatsappMessageId: message.id,
          direction: 'INBOUND',
          senderType: 'CUSTOMER',
          messageType: message.type,
          textContent: textoMedia,
          mediaId: mediaId || null,
          rawPayload: message,
          occurredAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date()
        }).then(function(resultadoCRM) {
          // Mismo criterio de idempotencia que el mensaje de texto: si ya
          // existía el whatsapp_message_id, no se repite descarga, IA, ni envío.
          if (resultadoCRM.duplicado) {
            liberarLockSiLoReclamamos(fromMedia, yaHabiaMensajeEnProcesoMedia);
            return;
          }
          if (message.referral && resultadoCRM.lead) capturarReferral(resultadoCRM.lead, message.referral, message.id);

          console.log('Mensaje tipo ' + message.type + ' de ' + fromMedia + ' (message_id=' + message.id + ') — descargando y respondiendo');

          if (pausadoTodo || pausados[fromMedia]) {
            liberarLockSiLoReclamamos(fromMedia, yaHabiaMensajeEnProcesoMedia);
            return;
          }
          if (yaHabiaMensajeEnProcesoMedia) return; // lock de OTRO mensaje de este número — no tocarlo, ya quedó guardado

          // Guardamos primero un marcador genérico (por si la descarga falla o tarda),
          // y lo actualizamos con la URL real en cuanto la tengamos.
          if (!conversaciones[fromMedia]) conversaciones[fromMedia] = [];
          var indiceMensaje = conversaciones[fromMedia].length;
          conversaciones[fromMedia].push({ role: 'user', content: textoMedia, ts: Date.now() });
          if (conversaciones[fromMedia].length > 12) { conversaciones[fromMedia] = conversaciones[fromMedia].slice(-12); indiceMensaje = conversaciones[fromMedia].length - 1; }
          guardarConversacion(fromMedia);

          if (mediaId) {
            descargarMediaDeMetaYSubir(mediaId, esVideoTipo).then(function(urlPublica) {
              var prefijo = message.type === 'image' ? '[IMAGEN]' : message.type === 'audio' ? '[AUDIO]' : '[ARCHIVO]';
              var contenidoConUrl = prefijo + ' ' + urlPublica;
              // Actualiza el mensaje en el historial (si todavía está en la posición esperada)
              if (conversaciones[fromMedia] && conversaciones[fromMedia][indiceMensaje] && conversaciones[fromMedia][indiceMensaje].content === textoMedia) {
                conversaciones[fromMedia][indiceMensaje].content = contenidoConUrl;
                guardarConversacion(fromMedia);
              }
              if (resultadoCRM.mensajeId) {
                actualizarTextoMensajeCRM(resultadoCRM.mensajeId, contenidoConUrl);
              }
              console.log('Media del lead guardada con URL: ' + urlPublica);
            }).catch(function(error) {
              console.error('Error descargando media del lead:', error.message);
            });
          }

          setTimeout(function() { procesarMensaje(fromMedia, textoMedia); }, 500);
        });
      }

      // 🆕 Rastreo de fallo silencioso (29 jul) — si ningún bloque anterior
      // marcó tipoDeMensajeManejado, el mensaje se está descartando sin
      // guardarse en el CRM y sin que Olivia responda. Antes esto pasaba
      // completamente inadvertido (sin log, sin excepción). Se deja
      // constancia explícita y se avisa a Lili para no perder el lead sin
      // aviso. No se loguea el contenido del mensaje (solo tipo/remitente/
      // id), mismo criterio de sanitización que el resto del webhook.
      //
      // 🆕 ETAPA 1 (3 ago 2026): antes la alerta a Lili dependía de que
      // message.from viniera presente — exactamente el caso que este fix
      // cubre (from vacío/corrupto). Ahora la alerta SIEMPRE se dispara
      // cuando el mensaje no se pudo manejar (salvo que sea un eco de
      // nuestro propio número de negocio, PHONE_NUMBER_ID), usando
      // numeroResuelto si lo hay y, si no, un marcador explícito — nunca
      // se vuelve a perder un lead en silencio por falta de número.
      if (!tipoDeMensajeManejado) {
        console.error('❌ Mensaje entrante NO MANEJADO — se descartó sin guardar en el CRM. type=' +
          (message.type || 'desconocido') + ', from=' + (message.from || 'desconocido') +
          ', message_id=' + (message.id || 'desconocido'));
        if (message.from !== PHONE_NUMBER_ID) {
          var camposPresentes = Object.keys(message).join(', ');
          var motivoAlerta = 'Llegó un mensaje de tipo "' + (message.type || 'desconocido') +
            '" que el sistema todavía no sabe procesar. message_id=' + (message.id || 'desconocido') +
            (message.timestamp ? (', timestamp=' + message.timestamp) : '') +
            '. Campos presentes en el mensaje: ' + camposPresentes +
            '. Revísalo manualmente — no se guardó ni se respondió automáticamente.';
          notificarLili(numeroResuelto || 'SIN_NUMERO_IDENTIFICABLE', motivoAlerta);
        }
      }
    }
  } catch (error) {
    console.error('Error webhook:', error.message);
  }
});

// 🆕 FASE 5 (26 jul) — extraído a una función `let`-bound (en vez de una
// llamada inline a axios.post) únicamente para poder inyectar un stub en
// las pruebas (mismo patrón que app.__setPoolParaPruebas) — la
// implementación real, usada en producción, es exactamente la misma
// llamada que ya existía. Reutilizada por el intento principal, el
// reintento automático, y la segunda llamada del cotizador (Fase 5).
let llamarClaude = function(systemPrompt, mensajes) {
  return axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5', max_tokens: 600, system: systemPrompt, messages: mensajes },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 5 (26 jul) — ruta única de escalamiento seguro para cualquier
// falla del flujo de cotización de repisa (cantidad>1, requiere_aprobacion,
// o cualquier error inesperado). El cliente SIEMPRE recibe un mensaje —
// nunca silencio, nunca el tag crudo.
//
// 🆕 FASE 6 (27 jul) — acepta un mensajeCliente opcional para casos que
// necesitan una explicación específica en vez del genérico "es más
// personalizada" (hoy: profundidad>30cm, ver resolverPrecioRepisa()).
// ═══════════════════════════════════════════════════════════════════════════
function escalarCotizacionSinPrecio(from, razonInterna, mensajeCliente) {
  var mensaje = mensajeCliente || 'Esa medida es más personalizada. Déjame confirmarla con Lili para darte el valor exacto 😊';
  agregarMensaje(from, 'assistant', mensaje);
  enviarMensaje(from, mensaje);
  notificarLili(from, 'Cotización de repisa requiere aprobación manual: ' + razonInterna);
  marcarPausado(from);
  console.log('💲⏭️ Cotización de repisa escalada para ' + from + ' — ' + razonInterna);
  delete procesando[from];
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FASE 5 (26 jul) — intercepta el tag [COTIZAR_REPISA:...], calcula el
// precio con resolverPrecioRepisa() (nunca Claude), y hace una SEGUNDA
// llamada a Claude con el precio ya inyectado para que redacte la
// respuesta final. Ver docs/COTIZADOR_V2_PLAN.md para el diseño completo.
//
// - Punto A (acordado): la respuesta de la PRIMERA llamada (con el tag)
//   nunca llega aquí siquiera — el llamador nunca la pasa a
//   agregarMensaje(). Esta función solo guarda el resultado de la
//   SEGUNDA llamada.
// - Defensa en profundidad: vuelve a chequear elegibilidad por cantidad
//   aunque el prompt ya le dice a Claude que no emita el tag si
//   cantidad > 1 — nunca confiar solo en que el modelo siguió la
//   instrucción.
// - Sin reintento en la segunda llamada (decisión de Lili: mantener esta
//   ruta simple y predecible) — cualquier falla cae directo en
//   escalarCotizacionSinPrecio().
// - procesando[from] se limpia en TODAS las salidas (éxito, escalamiento
//   por regla de negocio, o error) — nunca deja al lead "trabado".
// ═══════════════════════════════════════════════════════════════════════════
async function manejarCotizacionRepisa(from, texto, tag, systemConContexto, mensajesLimpios) {
  try {
    if (!tag.elegibleParaCalculoAutomatico) {
      escalarCotizacionSinPrecio(from, 'cantidad=' + tag.cantidad + ' (mayor a 1 — sin lógica de descuento por volumen implementada, ver docs/PENDIENTES.md)');
      return;
    }

    var resultado = resolverPrecioRepisa(
      { largoCm: tag.largoCm, profundidadCm: tag.profundidadCm, modalidad: tag.modalidadParaResolver },
      preciosRepisas
    );

    if (resultado.tipoResolucion === 'requiere_aprobacion') {
      escalarCotizacionSinPrecio(
        from,
        'resolverPrecioRepisa devolvió requiere_aprobacion (' + (resultado.alerta || 'sin alerta específica') + ')',
        resultado.mensajeParaCliente || null
      );
      return;
    }

    // 🆕 (27 jul) — estilo del mensaje final corregido por Lili tras ver el
    // primer caso real (110×25 → $380.000): material, cierre y tiempos de
    // fabricación específicos para esta redacción (segunda llamada).
    var textoTiemposRepisa = tag.modalidadParaResolver === 'enviado'
      ? 'El tiempo de fabricación es de 5 a 6 días, más 2 días adicionales por el envío a tu ciudad.'
      : 'El tiempo de fabricación e instalación es de 5 a 6 días.';

    var bloqueResultado = '\n\nPRECIO YA CALCULADO POR EL SISTEMA para esta repisa (largo=' + tag.largoCm + 'cm, profundidad=' + tag.profundidadCm +
      'cm, modalidad=' + tag.modalidadTag + '): $' + resultado.precioFinalSugerido.toLocaleString('es-CO') +
      '. Redacta la respuesta final al cliente usando este precio exacto — NO lo recalcules, NO lo cambies, NO lo redondees de nuevo. ' +
      'Sigue tus reglas normales: características antes que precio, tono cálido. ' +
      'Material: di "roble natural" o "alistonado" — NUNCA digas "roble macizo". ' +
      textoTiemposRepisa + ' ' +
      'Cierra con esta pregunta EXACTA: "¿Te gustaría que avancemos con esta medida?" — NUNCA uses "¿Arrancamos?" ni otra variante para esta pregunta de cierre. ' +
      'Después de esa pregunta, agrega una frase corta y cálida diciendo que si la repisa queda lista antes de tiempo, se le avisa. ' +
      'NUNCA menciones que hubo un cálculo interno ni ningún tag.';

    var response2 = await llamarClaude(systemConContexto + bloqueResultado, mensajesLimpios);
    var respuestaFinal = response2.data.content[0].text;
    // Defensivo: por si la segunda llamada, contra toda instrucción, repitiera
    // algún tag — nunca debe llegar nada de esto al cliente.
    var textoLimpioFinal = respuestaFinal
      .replace(/\[ESCALAR\]/g, '')
      .replace(/\[FOTOS_EXTRA\]/g, '')
      .replace(/\[COTIZAR_REPISA:[^\]]*\]/g, '')
      .trim();

    agregarMensaje(from, 'assistant', textoLimpioFinal); // único agregarMensaje de todo el flujo de cotización

    if (!seguimientos[from] || (seguimientos[from].estado !== 'cerrado_venta' && seguimientos[from].estado !== 'cerrado_perdido' && seguimientos[from].estado !== 'esperando_info' && seguimientos[from].estado !== 'esperando_decision' && seguimientos[from].estado !== 'cotizacion_enviada')) {
      // Este flujo (manejarCotizacionRepisa) SOLO existe para cotizaciones de
      // Repisa Flotante (ver resolverPrecioRepisa/tag.largoCm arriba) — el
      // producto aquí nunca es ambiguo, no hace falta resolverProductoParaFotos.
      // nivelIntencion queda null a propósito: esta función no recibe leadId
      // (solo from/texto/tag), así que no tiene forma barata de consultar
      // leads.buy_intent sin agregar un parámetro nuevo a los 3 call sites —
      // se acepta la cadencia por defecto aquí (simplificación deliberada,
      // caso poco frecuente: ya se le dio un precio real, no es un lead frío).
      seguimientos[from] = { estado: 'saludo_sin_respuesta', timestamp: Date.now(), intentos: 0, ultimoMensajeLead: Date.now(), producto: 'Repisa Flotante', nivelIntencion: null };
      guardarSeguimiento(from);
    }

    enviarMensaje(from, textoLimpioFinal);
    console.log('💲✅ Cotización de repisa resuelta y enviada para ' + from + ': $' + resultado.precioFinalSugerido.toLocaleString('es-CO') + ' (' + resultado.tipoResolucion + ')');
    delete procesando[from];
  } catch (error) {
    console.error('❌ Error en flujo de cotización de repisa para ' + from + ':', error.message);
    escalarCotizacionSinPrecio(from, 'error inesperado: ' + error.message);
  }
}

function procesarMensaje(from, texto, leadId, referralData) {
  if (!conversaciones[from]) conversaciones[from] = [];

  var sinRespuestasAgente = conversaciones[from].filter(function(m) { return m.role === 'assistant'; }).length === 0;
  var textoLower = texto.toLowerCase();
  var mencionaRepisa = textoLower.indexOf('repisa') !== -1 || textoLower.indexOf('estante') !== -1 || textoLower.indexOf('shelf') !== -1;

  // Durante la campaña de retargeting (100% enfocada en repisas), cualquier
  // primer mensaje que NO mencione explícitamente otro mueble distinto activa
  // el flujo de repisas con el saludo promocional. Solo si el lead dice
  // "escritorio", "recibidor", "mesa", "cama" en su primer mensaje, se omite
  // el saludo de repisas y Olivia lo atiende en el flujo de ese producto.
  var mencionaOtroMueble = textoLower.indexOf('escritorio') !== -1 ||
                           textoLower.indexOf('recibidor') !== -1 ||
                           textoLower.indexOf('mesa') !== -1 ||
                           textoLower.indexOf('cama') !== -1 ||
                           textoLower.indexOf('nochero') !== -1;

  var esPrimerMensaje;
  if (esCampanaActiva()) {
    // Campaña activa: primer mensaje sin mención de otro mueble → flujo repisa
    esPrimerMensaje = sinRespuestasAgente && !mencionaOtroMueble;
  } else {
    // Fuera de campaña: comportamiento original — solo activa si menciona repisa
    esPrimerMensaje = sinRespuestasAgente && mencionaRepisa;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 🆕 FASE 1B (23 jul) — si es el primer mensaje del lead y tenemos su
  // leadId, buscamos si respondió un formulario de Lead Ads vinculado y
  // reciente (ventana de 48h). Si lo hay, Meta ya le mostró el saludo largo
  // y las características/precio de referencia DENTRO del propio
  // formulario — Olivia no debe repetirlo. La supresión del saludo largo la
  // logra la INSTRUCCIÓN de texto que se agrega más abajo al system prompt
  // (independiente de esPrimerMensaje). `esPrimerMensaje` en cambio solo
  // controla el envío automático de las 2 fotos del producto — se fuerza a
  // `true` (no `false`) para que las fotos SÍ se envíen también en este
  // caso (decisión de Lili: "refuerza la venta en el momento de cierre").
  //
  // 🐛 FIX (23 jul, mismo día): esto antes decía `esPrimerMensaje = false`,
  // lo cual bloqueaba las fotos por error — esPrimerMensaje es la ÚNICA
  // variable que decide si se llama a enviarFotosSaludo() más abajo, y la
  // supresión del saludo nunca dependió de ella. Corregido.
  //
  // Si no hay leadId, no es el primer mensaje, o no hay formulario
  // vinculado reciente: promesaFormulario resuelve a null y el
  // comportamiento es idéntico al de antes de la Fase 1B.
  // ═══════════════════════════════════════════════════════════════════════
  var promesaFormulario = (sinRespuestasAgente && leadId)
    ? obtenerFormularioVinculadoReciente(leadId).catch(function(e) {
        console.error('Error buscando formulario vinculado para lead ' + leadId + ':', e.message);
        return null;
      })
    : Promise.resolve(null);

  var promesaProductoPersistido = leadId
    ? obtenerProductoPersistidoLead(leadId).catch(function(e) {
        console.error('Error buscando producto activo para lead ' + leadId + ':', e.message);
        return null;
      })
    : Promise.resolve(null);

  // 🆕 Etapa 2, punto 2 — intención de compra del formulario, guardada por
  // manejarEventoLeadgen(). Solo importa para el primer saludo_sin_respuesta
  // (ver más abajo, dónde se usa) — el resto del flujo la ignora.
  var promesaIntencionCompra = leadId
    ? obtenerIntencionCompraLead(leadId).catch(function(e) {
        console.error('Error buscando intención de compra para lead ' + leadId + ':', e.message);
        return null;
      })
    : Promise.resolve(null);

  Promise.all([promesaFormulario, promesaProductoPersistido, promesaIntencionCompra]).then(function(contextosLead) {
  var formularioVinculado = contextosLead[0];
  var productoPersistido = contextosLead[1];
  var intencionCompraPersistida = contextosLead[2];
  var bloqueFormulario = formularioVinculado ? formatearRespuestasFormulario(formularioVinculado) : null;
  var productoFormularioParaFotos = formularioVinculado
    ? detectarProductoFormulario(formularioVinculado.field_data || [])
    : null;
  if (bloqueFormulario) {
    esPrimerMensaje = true; // asegura el envío de fotos también para leads de formulario
    console.log('📋 Contexto de formulario aplicado al primer mensaje de ' + from);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 🆕 AJUSTE 1 (23 jul) — si NO hay formulario vinculado (prioridad del
  // formulario sobre el referral, por ser más específico) y el lead no
  // mencionó ningún producto explícitamente en su propio texto, pero sí
  // tenemos referral_data identificable del anuncio de origen: mismo
  // criterio que el formulario — inyecta el contexto del anuncio y fuerza
  // esPrimerMensaje a true (fotos también aquí, mismo criterio aprobado).
  // ═══════════════════════════════════════════════════════════════════════
  var bloqueReferral = null;
  var productoReferral = null;
  if (!bloqueFormulario && sinRespuestasAgente && !mencionaRepisa && !mencionaOtroMueble && referralData) {
    productoReferral = detectarProductoDesdeReferral(referralData);
    bloqueReferral = formatearContextoReferral(referralData, productoReferral);
    if (bloqueReferral) {
      esPrimerMensaje = true;
      console.log('📎 Contexto de referral aplicado al primer mensaje de ' + from + (productoReferral ? ' (producto: ' + productoReferral + ')' : ''));
    }
  }

  var systemConContexto = getSystemPrompt();
  if (notas[from] && notas[from].trim() !== '') {
    systemConContexto += '\n\nNOTA PRIVADA DE LILI SOBRE ESTE LEAD (información de contexto, puede venir de audios, fotos, o conversaciones fuera del sistema — tenla en cuenta para tu respuesta y seguimiento):\n"' + notas[from] + '"';
  }
  if (bloqueFormulario) {
    systemConContexto += '\n\n' + bloqueFormulario +
      '\n\nEste lead ya vio tu saludo y las características/precio de referencia en el mensaje de bienvenida del formulario de Meta antes de escribir por WhatsApp — NO vuelvas a saludar largo ni repitas la introducción. Reconoce brevemente sus respuestas, confirma características y precio siguiendo tus reglas de este producto (características antes que precio, siempre), y cierra con una pregunta de acción concreta.';
  }
  if (bloqueReferral) {
    systemConContexto += '\n\n' + bloqueReferral +
      '\n\nEste lead llegó desde este anuncio y ya vio el mensaje de bienvenida de Meta antes de escribir — NO le preguntes genéricamente qué mueble le interesa. Reconoce que viene del anuncio, confirma características y precio de este producto siguiendo tus reglas (características antes que precio, siempre), y haz una pregunta de acción concreta para avanzar.';
  }

  // 🆕 Deduplicación determinística de formulario repetido (caso real
  // Deissy) — ver detectarMensajeDuplicado() para el criterio exacto. Se
  // excluyen los placeholders sintéticos de media ("[El cliente envió...]")
  // porque dos fotos/audios DISTINTOS comparten el mismo texto genérico —
  // compararlos produciría falsos positivos (marcar una foto nueva como
  // reenvío de la anterior solo porque ambas dicen "[El cliente envió una
  // imagen]"). NO se bloquea el mensaje — Claude lo sigue recibiendo, solo
  // se le avisa para que no reinicie el saludo ni repita la misma pregunta.
  var esPlaceholderMedia = typeof texto === 'string' && texto.indexOf('[El cliente envió ') === 0;
  var esReenvioDuplicado = !esPlaceholderMedia && detectarMensajeDuplicado(conversaciones[from], texto);
  if (esReenvioDuplicado) {
    systemConContexto += '\n\nEste mensaje es idéntico a uno que el cliente ya envió antes en esta conversación (posible reenvío técnico del formulario). YA fue respondido. No reinicies el saludo ni repitas la misma pregunta. Continúa desde donde quedó el hilo, o si no hay nada nuevo que agregar, pregunta con naturalidad si sigue interesado.';
    console.log('🔁 Mensaje duplicado detectado para ' + from + ' — nota inyectada al system prompt, no se bloquea');
    registrarEventoLead(leadId || null, 'DUPLICATE_MESSAGE_DETECTED', {
      actor: 'SYSTEM',
      source: 'procesarMensaje',
      metadata: { longitud_texto: texto.length }
    });
  }

  // Si el último mensaje del lead es una imagen real (ya descargada y subida a
  // Cloudinary), se la mandamos a Claude con visión para que pueda "verla" de
  // verdad, en vez de solo trabajar con el texto genérico "[El cliente envió una imagen]".
  var esImagenReal = typeof texto === 'string' && texto.indexOf('[IMAGEN] ') === 0;

  var promesaMensajes;
  if (esImagenReal) {
    var urlImagenLead = texto.slice(9);
    promesaMensajes = axios.get(urlImagenLead, { responseType: 'arraybuffer' }).then(function(imgResp) {
      var base64Img = Buffer.from(imgResp.data).toString('base64');
      var mediaType = imgResp.headers['content-type'] || 'image/jpeg';
      // Reemplaza el último mensaje (el marcador de texto) por uno con la imagen real,
      // sin alterar el historial guardado en la BD — solo para esta llamada a Claude.
      var historialConImagen = conversaciones[from].slice(0, -1).concat([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Img } },
          { type: 'text', text: 'El cliente envió esta imagen por WhatsApp.' }
        ]
      }]);
      return historialConImagen;
    }).catch(function(error) {
      console.error('No se pudo cargar la imagen para Claude, sigue con texto:', error.message);
      return conversaciones[from];
    });
  } else {
    promesaMensajes = Promise.resolve(conversaciones[from]);
  }

  promesaMensajes.then(function(mensajesParaClaude) {
  // Filtrar el campo ts antes de enviar a Claude — la API no acepta campos extra
  var mensajesLimpios = mensajesParaClaude.map(function(m) {
    if (Array.isArray(m.content)) return { role: m.role, content: m.content };
    return { role: m.role, content: m.content };
  });
  llamarClaude(systemConContexto, mensajesLimpios).then(function(response) {
    var respuesta = response.data.content[0].text;
    console.log('Claude: ' + respuesta);

    // 🆕 FASE 5 (26 jul) — intercepta [COTIZAR_REPISA:...] ANTES de guardar
    // nada. La respuesta cruda con el tag NUNCA pasa por agregarMensaje()
    // ni enviarMensaje() — es efímera. manejarCotizacionRepisa() se encarga
    // de todo el resto de este turno (segunda llamada, guardado, envío, o
    // escalamiento si algo falla) y de limpiar procesando[from] al final.
    var tagCotizacion = extraerTagCotizarRepisa(respuesta);
    if (tagCotizacion) {
      console.log('💲 Tag COTIZAR_REPISA detectado para ' + from + ': ' + JSON.stringify(tagCotizacion));
      manejarCotizacionRepisa(from, texto, tagCotizacion, systemConContexto, mensajesLimpios);
      return;
    }

    // 🆕 FASE 7 (27 jul) — Claude no emitió el tag. Si además eligió
    // escalar ([ESCALAR]), antes de aceptar ese escalamiento intentamos
    // resolver la cotización nosotros mismos desde el historial reciente
    // — ver detectarCotizacionRepisaDesdeContexto(). Si el sistema puede
    // cotizar con seguridad, gana sobre el escalamiento genérico del
    // modelo: nunca se envía el [ESCALAR] de Claude ni se notifica a
    // Lili en ese caso. Solo corre con el flag encendido — con el flag
    // apagado, cero cambio de comportamiento.
    if (cotizadorRepisasV2Habilitado() && respuesta.indexOf('[ESCALAR]') !== -1) {
      var contextoRepisa = detectarCotizacionRepisaDesdeContexto({ mensajeActual: texto, historialReciente: mensajesParaClaude });
      if (contextoRepisa) {
        console.log('💲🔍 [ESCALAR] de Claude anulado — cotización segura detectada por contexto para ' + from + ': ' + JSON.stringify(contextoRepisa));
        var tagSintetico = {
          tagEncontrado: true,
          largoCm: contextoRepisa.largoCm,
          profundidadCm: contextoRepisa.profundidadCm,
          cantidad: contextoRepisa.cantidad,
          ciudad: contextoRepisa.ciudad,
          modalidadTag: contextoRepisa.modalidad,
          modalidadParaResolver: MAPA_MODALIDAD_TAG_A_FUNCION[contextoRepisa.modalidad] || contextoRepisa.modalidad,
          elegibleParaCalculoAutomatico: contextoRepisa.cantidad === 1
        };
        // Si resolverPrecioRepisa() (dentro de manejarCotizacionRepisa)
        // igual devuelve requiere_aprobacion (ej. envío nacional sin fila
        // exacta), el [ESCALAR] de Claude se respeta de todas formas —
        // manejarCotizacionRepisa ya cae en escalarCotizacionSinPrecio()
        // en ese caso, con el mismo log '💲⏭️ ... escalada' de siempre.
        manejarCotizacionRepisa(from, texto, tagSintetico, systemConContexto, mensajesLimpios);
        return;
      }
      console.log('💲🔍 Claude escaló con [ESCALAR] y no hay cotización segura detectable por contexto para ' + from + ' — se respeta el escalamiento');
    }

    // El catálogo actual solo tiene fotos generales por producto, sin medios
    // etiquetados por detalle. Una petición específica se escala de forma
    // determinística: nunca se sustituye por la foto "más parecida".
    if (solicitudFotoDetalleEspecifico(texto) && respuesta.indexOf('[ESCALAR]') === -1) {
      respuesta = 'Para mostrarte justo ese detalle, ya le aviso a Lili para que revise si tenemos esa foto y te la envíe 😊 [ESCALAR]';
    }

    // Se resuelve y persiste en TODOS los turnos, no solo cuando ya se van a
    // enviar fotos. Así un "Sí" posterior y un reinicio del proceso conservan
    // el producto activo establecido durante la conversación. Se adelanta
    // aquí (antes vivía después de agregarMensaje) porque el filtro de envío
    // gratis de más abajo necesita saber el producto activo.
    var productoParaFotos = resolverProductoParaFotos({
      textoActual: texto,
      respuestaClaude: respuesta,
      historial: conversaciones[from],
      productoContextoOrigen: productoFormularioParaFotos || productoReferral,
      productoPersistido: productoPersistido
    });
    if (productoParaFotos && leadId && productoParaFotos !== productoPersistido) {
      guardarProductoPersistidoLead(leadId, productoParaFotos);
    }

    // 🆕 FIX 3 (29 jul) — Mesa Auxiliar (y cualquier otro producto sin
    // mecanismo propio de envío) nunca debe prometer envío gratis/incluido:
    // el prompt ya lo prohíbe (ver getSystemPrompt()), esto es la capa dura
    // de respaldo por si Claude lo dice de todas formas con otras palabras.
    // Mensaje de reemplazo SIEMPRE fijo — nunca una segunda llamada a
    // Claude, para no arriesgar que esa segunda llamada alucine también.
    if (respuestaPrometeEnvioGratisSinAprobar(respuesta, productoParaFotos) && respuesta.indexOf('[ESCALAR]') === -1) {
      console.log('🚚⛔ Respuesta de Claude prometía envío gratis/incluido sin aprobar (producto: ' + (productoParaFotos || 'desconocido') + ') para ' + from + ' — sustituida por escalamiento. Original: ' + respuesta.slice(0, 200));
      respuesta = 'Para confirmarte el valor exacto del envío, ya le aviso a Lili para que te lo confirme 😊 [ESCALAR]';
    }

    agregarMensaje(from, 'assistant', respuesta);

    var necesitaEscalar = respuesta.indexOf('[ESCALAR]') !== -1;
    var claudePidioFotosExtra = respuesta.indexOf('[FOTOS_EXTRA]') !== -1;
    var clientePidioFotos = solicitudExplicitaFotos(texto, conversaciones[from]);
    var necesitaFotosExtra = !necesitaEscalar && clientePidioFotos;
    if (claudePidioFotosExtra && !clientePidioFotos) {
      console.log('📸⛔ [FOTOS_EXTRA] ignorado para ' + from + ' — el cliente no pidió fotos explícitamente');
    }
    var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').replace(/\[FOTOS_EXTRA\]/g, '').trim();

    if (necesitaEscalar) {
      notificarLili(from, texto.substring(0, 100));
      marcarPausado(from);
      console.log('Escalado. Numero pausado: ' + from);
    } else {
      if (!seguimientos[from] || (seguimientos[from].estado !== 'cerrado_venta' && seguimientos[from].estado !== 'cerrado_perdido' && seguimientos[from].estado !== 'esperando_info' && seguimientos[from].estado !== 'esperando_decision' && seguimientos[from].estado !== 'cotizacion_enviada')) {
        seguimientos[from] = { estado: 'saludo_sin_respuesta', timestamp: Date.now(), intentos: 0, ultimoMensajeLead: Date.now(), producto: productoParaFotos, nivelIntencion: intencionCompraPersistida };
        guardarSeguimiento(from);
      }
    }

    if (esPrimerMensaje) {
      enviarFotosSaludo(from, productoParaFotos)
        .then(function() {
          return new Promise(function(resolve) { setTimeout(resolve, 1000); });
        })
        .then(function() {
          enviarMensaje(from, textoLimpio);
          delete procesando[from];
        });
    } else if (necesitaFotosExtra && productoParaFotos) {
      enviarMensaje(from, textoLimpio);
      setTimeout(function() { enviarFotosExtra(from, productoParaFotos); }, 1500);
      delete procesando[from];
    } else if (necesitaFotosExtra) {
      console.log('📸⛔ Fotos no enviadas para ' + from + ' — producto activo no resuelto con certeza');
      enviarMensaje(from, textoLimpio);
      delete procesando[from];
    } else {
      enviarMensaje(from, textoLimpio);
      delete procesando[from];
    }
  }).catch(function(error) {
    var errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('❌ Error Claude (intento 1):', errorMsg);

    // Reintento automático después de 3 segundos — durante alta demanda de campaña
    // Claude puede fallar por rate limit o timeout puntual. Un solo reintento
    // resuelve la mayoría de estos casos sin que el lead reciba un mensaje de error.
    setTimeout(function() {
      llamarClaude(systemConContexto, mensajesLimpios).then(function(response) {
        console.log('✅ Reintento Claude exitoso para ' + from);
        var respuesta = response.data.content[0].text;

        // 🆕 FASE 5 — mismo intercepto que en el intento principal.
        var tagCotizacionReintento = extraerTagCotizarRepisa(respuesta);
        if (tagCotizacionReintento) {
          console.log('💲 Tag COTIZAR_REPISA detectado (reintento) para ' + from + ': ' + JSON.stringify(tagCotizacionReintento));
          manejarCotizacionRepisa(from, texto, tagCotizacionReintento, systemConContexto, mensajesLimpios);
          return;
        }

        agregarMensaje(from, 'assistant', respuesta);
        var necesitaEscalar = respuesta.indexOf('[ESCALAR]') !== -1;
        var textoLimpio = respuesta.replace(/\[ESCALAR\]/g, '').replace(/\[FOTOS_EXTRA\]/g, '').trim();
        if (necesitaEscalar) {
          notificarLili(from, texto.substring(0, 100));
          marcarPausado(from);
        } else {
          if (!seguimientos[from] || (seguimientos[from].estado !== 'cerrado_venta' && seguimientos[from].estado !== 'cerrado_perdido' && seguimientos[from].estado !== 'esperando_info' && seguimientos[from].estado !== 'esperando_decision' && seguimientos[from].estado !== 'cotizacion_enviada')) {
            if (from !== LILI_NUMERO) {
              // Mismo criterio de resolución de producto que el intento
              // principal (resolverProductoParaFotos ya está en scope vía
              // closure de procesarMensaje: productoPersistido,
              // productoFormularioParaFotos, productoReferral).
              var productoParaFotosReintento = resolverProductoParaFotos({
                textoActual: texto,
                respuestaClaude: respuesta,
                historial: conversaciones[from],
                productoContextoOrigen: productoFormularioParaFotos || productoReferral,
                productoPersistido: productoPersistido
              });
              seguimientos[from] = { estado: 'saludo_sin_respuesta', timestamp: Date.now(), intentos: 0, ultimoMensajeLead: Date.now(), producto: productoParaFotosReintento, nivelIntencion: intencionCompraPersistida };
              guardarSeguimiento(from);
            }
          }
        }
        enviarMensaje(from, textoLimpio);
        delete procesando[from];
      }).catch(function(error2) {
        // Falló dos veces — notificar a Lili para que atienda manualmente
        var errorMsg2 = error2.response ? JSON.stringify(error2.response.data) : error2.message;
        console.error('❌ Error Claude (intento 2, falló definitivo) para ' + from + ':', errorMsg2);
        delete procesando[from];
        notificarLili(from, '⚠️ El agente falló 2 veces al responder a este lead (error API). Revisa la conversación y responde manualmente.');
        marcarPausado(from);
      });
    }, 3000);
  });
  }); // cierra promesaMensajes.then
  }); // cierra promesaFormulario.then
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FOTOS POR PRODUCTO (26 jul) — corrige el bug reportado por Lili: antes
// TODAS las fotos que se enviaban (saludo y [FOTOS_EXTRA]) eran siempre de
// repisa, sin importar el producto del que se estuviera hablando (viejo
// objeto `FOTOS`, ya eliminado). Este mapa y la función de detección de
// abajo ya están conectados en `enviarFotosSaludo()`/`enviarFotosExtra()`.
//
// URLs reales de Cloudinary provistas por Lili — los 7 productos del
// catálogo completo, cada uno con sus fotos propias.
// ═══════════════════════════════════════════════════════════════════════════
const FOTOS_POR_PRODUCTO = {
  'Repisa Flotante': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785109762/Repisa_110_cm_ffxcqt.jpg',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785108271/Repisa_Carrusel_1_Julio_25_u5j01z.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785108113/Repisa_Estudio_1_niaxbp.png'
  ],
  'Escritorio Flotante': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785107535/Escritorio_en_Dormitorio_2_ueu0zo.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785107535/Escritorio_en_Dormitorio_3_upif0r.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782881224/Escritorio_en_Habitaci%C3%B3n_8_Close_Up_smdlap.png'
  ],
  'Mesa Auxiliar': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782876200/Sofa_2_a4adrt.jpg',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782876256/Dormitorio_3-2_hjdgpr.jpg'
  ],
  'Recibidor': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782883346/Recibidor_Integrado_1_mz068s.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782799076/Recibidor_1-2_aoaaej.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782799073/Recibidor_5-1_d7vs6w.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782880675/Lunes_13-2_ddxk2o.png'
  ],
  'Escritorio con Cajones': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782883771/Escritorio_2_saeppg.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1782883770/Escritorio_1_ksghk1.png'
  ],
  'Cama': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785107886/Cama_1-3_cjeavu.jpg',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785107922/Cama_3-2_a8rktc.png'
  ],
  'Mesa de Centro con Jardinera': [
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785111138/Mesa_1_fmmna8.png',
    'https://res.cloudinary.com/dcdn1l8jb/image/upload/v1785111144/Mesa_2_t4umxy.png'
  ]
};

// No existe fallback de producto para medios. Si el producto no se puede
// resolver con certeza, el envío se cancela: nunca se sustituyen fotos con
// Repisa Flotante ni con ningún otro producto.
const PRODUCTO_FOTOS_FALLBACK = null;

// Detecta el producto para elegir qué fotos enviar. Mismo patrón de
// palabras clave que ya usa detectarProductoPorTexto() (Fase 1B/Ajuste 1
// del cotizador) — pero es una función INDEPENDIENTE, con su propia tabla,
// para no tocar ni arriesgar ese código (regla explícita: no mezclar con
// la rama del cotizador). Cubre los 7 productos del catálogo completo,
// más las reglas de desambiguación que acordamos:
//
// 1. Frases específicas primero (más confiables): escritorio con
//    cajones/base/grande/$3.200.000 vs escritorio flotante/para pared/
//    $1.590.000; mesa de centro/jardinera/para sala vs mesa auxiliar/
//    pequeña/de noche.
// 2. Resto de productos sin ambigüedad conocida (repisa, recibidor, cama).
// 3. Si solo aparece la palabra genérica "escritorio" o "mesa" sin
//    calificador, usa un default explícito (Escritorio Flotante / Mesa
//    Auxiliar) — y lo deja logueado siempre, para poder revisar después
//    si el default está acertando.
function detectarProductoParaFotos(textos) {
  var texto = (Array.isArray(textos) ? textos : [textos]).filter(Boolean).join(' ').toLowerCase();
  if (!texto) return null;

  var clavesEscritorioCajones = ['escritorio con cajones', 'escritorio con base', 'escritorio grande', '3.200.000', '3200000'];
  var clavesEscritorioFlotante = ['escritorio flotante', 'escritorio para pared', '1.590.000', '1590000'];
  if (clavesEscritorioCajones.some(function(c) { return texto.indexOf(c) !== -1; })) return 'Escritorio con Cajones';
  if (clavesEscritorioFlotante.some(function(c) { return texto.indexOf(c) !== -1; })) return 'Escritorio Flotante';

  var clavesMesaCentro = ['mesa de centro', 'mesa jardinera', 'mesa para sala'];
  var clavesMesaAuxiliar = ['mesa auxiliar', 'mesa pequeña', 'mesa pequena', 'mesa de noche'];
  if (clavesMesaCentro.some(function(c) { return texto.indexOf(c) !== -1; })) return 'Mesa de Centro con Jardinera';
  if (clavesMesaAuxiliar.some(function(c) { return texto.indexOf(c) !== -1; })) return 'Mesa Auxiliar';

  if (texto.indexOf('repisa') !== -1 || texto.indexOf('estante') !== -1) return 'Repisa Flotante';
  if (texto.indexOf('recibidor') !== -1 || texto.indexOf('banco') !== -1) return 'Recibidor';
  if (texto.indexOf('cama') !== -1 || texto.indexOf('nochero') !== -1) return 'Cama';

  // Palabra genérica sin calificador — default logueado explícitamente.
  if (texto.indexOf('escritorio') !== -1) {
    console.log('📸⚠️ Fotos: "escritorio" sin calificador — usando default Escritorio Flotante. Texto: ' + texto.slice(0, 200));
    return 'Escritorio Flotante';
  }
  if (texto.indexOf('mesa') !== -1) {
    console.log('📸⚠️ Fotos: "mesa" sin calificador — usando default Mesa Auxiliar. Texto: ' + texto.slice(0, 200));
    return 'Mesa Auxiliar';
  }

  return null;
}

function normalizarTextoFotos(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// El backend, no Claude, tiene la última palabra sobre si se permite enviar
// fotos extra. Una afirmación corta ("sí") solo cuenta cuando responde a la
// última pregunta del agente y esa pregunta hablaba explícitamente de fotos.
function solicitudExplicitaFotos(textoActual, historial) {
  var texto = normalizarTextoFotos(textoActual);
  var frasesDirectas = [
    'foto', 'imagen', 'como queda', 'como se ve', 'muestrame',
    'mostrarme', 'verla', 'ver el producto', 'ver la repisa',
    'mandamela', 'mandamelas', 'enviala', 'envialas'
  ];
  if (frasesDirectas.some(function(frase) { return texto.indexOf(frase) !== -1; })) return true;

  var esAfirmacionCorta = /^(si|claro|dale|listo|bueno|por favor)[\s.!?]*$/.test(texto.trim());
  if (!esAfirmacionCorta || !Array.isArray(historial)) return false;

  for (var i = historial.length - 1; i >= 0; i--) {
    var mensaje = historial[i];
    if (!mensaje || mensaje.role !== 'assistant' || typeof mensaje.content !== 'string') continue;
    var preguntaAnterior = normalizarTextoFotos(mensaje.content);
    return preguntaAnterior.indexOf('foto') !== -1 || preguntaAnterior.indexOf('imagen') !== -1;
  }
  return false;
}

function solicitudFotoDetalleEspecifico(textoActual) {
  var texto = normalizarTextoFotos(textoActual);
  var detalles = [
    'por dentro', 'interior', 'otro angulo', 'otro ángulo', 'de cerca',
    'close up', 'detalle', 'cajon', 'soporte', 'herrajes', 'parte de atras',
    'parte trasera', 'foto real', 'en una sala', 'en una habitacion'
  ];
  return detalles.some(function(detalle) {
    return texto.indexOf(normalizarTextoFotos(detalle)) !== -1;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 FIX 3 (29 jul) — filtro determinístico de "envío gratis/incluido" no
// aprobado. Caso real que lo motivó: Mesa Auxiliar no tiene ningún mecanismo
// que calcule el costo del envío nacional (a diferencia de Repisa Flotante,
// que sí lo resuelve por tabla fija o por fórmula — ver COTIZADOR_REPISAS_V2
// y las tarifas de repisas dentro de getSystemPrompt()). El prompt ya prohíbe
// esto (ver "NUNCA inventes... costos de envío" y la nota de Mesa Auxiliar
// en getSystemPrompt()) — este filtro es la capa dura de respaldo por si
// Claude lo afirma de todas formas con otra formulación.
//
// Alcance (dos listas, no una condición ad-hoc, mismo criterio que el flag
// del cotizador v2):
// - PRODUCTOS_CON_ENVIO_GRATIS_APROBADO: productos donde SÍ está aprobado un
//   envío gratis real. Vacía hoy — se llena solo si Lili aprueba un caso así.
// - PRODUCTOS_CON_MANEJO_PROPIO_DE_ENVIO: productos cuyo costo de envío ya
//   lo calcula un sistema propio, probado por separado. Hoy solo Repisa
//   Flotante: ahí "envío incluido" es una frase legítima cuando acompaña un
//   precio ya calculado por fórmula o tomado de la tabla fija de tarifas
//   (ver test/cotizador-v2*.test.js) — bloquearla ahí sería un falso
//   positivo sobre una regla que ya funciona en producción.
//
// El mensaje de reemplazo es SIEMPRE el mismo string fijo — nunca se genera
// con una segunda llamada a Claude, para no arriesgar que esa segunda
// llamada también alucine. Si Claude ya escaló por su cuenta ([ESCALAR] ya
// presente), este filtro no se activa — se respeta ese escalamiento igual
// que en los demás filtros de este archivo.
// ═══════════════════════════════════════════════════════════════════════════
var PRODUCTOS_CON_ENVIO_GRATIS_APROBADO = [];
var PRODUCTOS_CON_MANEJO_PROPIO_DE_ENVIO = ['Repisa Flotante'];

var PATRON_ENVIO = /\benv[ií]o\b|\benv[ií]a(?:mos)?\b|\bdespach\w*/i;
var PATRON_GRATUIDAD_ENVIO = /sin\s+costo|sin\s+cargo|\bgratis\b|gratuit\w*|no\s+(?:te\s+)?cobr\w*|por\s+(?:nuestra\s+)?cuenta|no\s+(?:tiene|paga|pagas)\s+costo|\binclu(?:ye|ido|ida|yen|ía)\w*\b/i;
var PATRON_NO_TE_PREOCUPES_POR_ENVIO = /no\s+te\s+preocupes\s+por.{0,20}(?:env[ií]o|costo)/i;

function respuestaPrometeEnvioGratisSinAprobar(respuesta, producto) {
  if (typeof respuesta !== 'string' || !respuesta) return false;
  if (PRODUCTOS_CON_ENVIO_GRATIS_APROBADO.indexOf(producto) !== -1) return false;
  if (PRODUCTOS_CON_MANEJO_PROPIO_DE_ENVIO.indexOf(producto) !== -1) return false;

  // Evalúa oración por oración (no el mensaje completo) para que una
  // palabra de "gratuidad" en una oración sin relación a envío (ej. un
  // descuento "incluido en el precio") no dispare el filtro por casualidad.
  var oraciones = respuesta.split(/[.!?\n]+/);
  for (var i = 0; i < oraciones.length; i++) {
    var oracion = oraciones[i];
    if (PATRON_NO_TE_PREOCUPES_POR_ENVIO.test(oracion)) return true;
    if (PATRON_ENVIO.test(oracion) && PATRON_GRATUIDAD_ENVIO.test(oracion)) return true;
  }
  return false;
}

function resolverProductoParaFotos(opciones) {
  opciones = opciones || {};

  // Un cambio explícito del cliente en el turno actual siempre gana.
  var productoActual = detectarProductoParaFotos([opciones.textoActual]);
  if (productoActual) return productoActual;

  // En saludos genéricos ("Quiero más información"), el producto confiable
  // puede venir únicamente del formulario/referral del anuncio.
  if (opciones.productoContextoOrigen && FOTOS_POR_PRODUCTO[opciones.productoContextoOrigen]) {
    return opciones.productoContextoOrigen;
  }

  // La columna leads.product conserva el producto incluso tras reinicios.
  if (opciones.productoPersistido && FOTOS_POR_PRODUCTO[opciones.productoPersistido]) {
    return opciones.productoPersistido;
  }

  // Respaldo para conversaciones existentes que todavía no tenían product
  // poblado: buscar desde el mensaje más reciente hacia atrás.
  var historial = Array.isArray(opciones.historial) ? opciones.historial : [];
  for (var i = historial.length - 1; i >= 0; i--) {
    var contenido = historial[i] && historial[i].content;
    if (typeof contenido !== 'string') continue;
    var productoHistorial = detectarProductoParaFotos([contenido]);
    if (productoHistorial) return productoHistorial;
  }

  // Útil en el primer turno cuando la respuesta de Claude nombra claramente
  // el producto identificado desde referral/formulario.
  var productoRespuesta = detectarProductoParaFotos([opciones.respuestaClaude]);
  return productoRespuesta || null;
}

async function obtenerProductoPersistidoLead(leadId) {
  if (!leadId) return null;
  var r = await pool.query('SELECT product FROM leads WHERE id = $1', [leadId]);
  return r.rows[0] && r.rows[0].product ? r.rows[0].product : null;
}

// 🆕 Etapa 2, punto 2 — intención de compra guardada por
// manejarEventoLeadgen() (leads.buy_intent), leída aquí para propagarla al
// primer seguimiento saludo_sin_respuesta que cree procesarMensaje().
async function obtenerIntencionCompraLead(leadId) {
  if (!leadId) return null;
  var r = await pool.query('SELECT buy_intent FROM leads WHERE id = $1', [leadId]);
  return r.rows[0] && r.rows[0].buy_intent ? r.rows[0].buy_intent : null;
}

function guardarProductoPersistidoLead(leadId, producto) {
  if (!leadId || !FOTOS_POR_PRODUCTO[producto]) return Promise.resolve(false);
  return pool.query(
    'UPDATE leads SET product = $2, updated_at = NOW() WHERE id = $1',
    [leadId, producto]
  ).then(function() {
    console.log('📸 Producto activo guardado para lead ' + leadId + ': ' + producto);
    return true;
  }).catch(function(e) {
    console.error('Error guardando producto activo para lead ' + leadId + ':', e.message);
    return false;
  });
}

// ─── SUBIDA DE ARCHIVOS DESDE EL PANEL (Cloudinary) ────────────────────────
// Para que Lili pueda mandar imágenes/audios desde el panel sin saltar a otra app.
// Necesita un "unsigned upload preset" configurado en Cloudinary (gratis, sin firma).
function subirACloudinary(buffer, mimetype, esVideo) {
  var cloudName = CLOUDINARY_CLOUD_NAME || 'dcdn1l8jb';
  var tipoRecurso = esVideo ? 'video' : 'image'; // Cloudinary usa "video" también para audio
  var url = 'https://api.cloudinary.com/v1_1/' + cloudName + '/' + tipoRecurso + '/upload';

  var FormData = require('form-data');
  var form = new FormData();
  form.append('file', buffer, { filename: 'archivo', contentType: mimetype });
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET || 'panel_unsigned');

  return axios.post(url, form, { headers: form.getHeaders() })
    .then(function(resp) { return resp.data.secure_url; });
}

function enviarAudio(to, urlAudio) {
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'audio', audio: { link: urlAudio } },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Audio enviado a ' + to);
  }).catch(function(error) {
    console.error('Error audio:', error.response ? JSON.stringify(error.response.data) : error.message);
  });
}
// ─── FIN SUBIDA DE ARCHIVOS ─────────────────────────────────────────────────

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

// Devuelve fotos únicamente cuando el producto existe en el catálogo.
// Producto desconocido/null devuelve []: nunca hay sustitución silenciosa.
function fotosParaProducto(producto) {
  return FOTOS_POR_PRODUCTO[producto] || [];
}

// Puras y testeables sin red (mismo criterio que extraerTagCotizarRepisa):
// qué par de fotos va en cada envío.
function seleccionarFotosSaludo(fotos) {
  return [fotos[0], fotos[1] || fotos[0]];
}
function seleccionarFotosExtra(fotos) {
  // Si el producto tiene 3+ fotos, esta vez muestra la 2ª y 3ª (distintas a
  // las que ya se vieron en el saludo); si solo tiene 2, no hay más
  // disponibles y se repiten.
  if (fotos.length >= 3) return [fotos[1], fotos[2]];
  return [fotos[0], fotos[1] || fotos[0]];
}

function enviarFotosSaludo(to, producto) {
  var par = seleccionarFotosSaludo(fotosParaProducto(producto));
  if (!par[0]) return Promise.resolve(false);
  return enviarImagen(to, par[0])
    .then(function() {
      return new Promise(function(resolve) { setTimeout(resolve, 1500); });
    })
    .then(function() {
      return enviarImagen(to, par[1]);
    });
}

function enviarFotosExtra(to, producto) {
  var par = seleccionarFotosExtra(fotosParaProducto(producto));
  if (!par[0]) return Promise.resolve(false);
  return enviarImagen(to, par[0])
    .then(function() {
      return new Promise(function(resolve) { setTimeout(resolve, 1500); });
    })
    .then(function() {
      return enviarImagen(to, par[1]);
    });
}

// Descarga un archivo multimedia que el LEAD mandó por WhatsApp (Meta solo da
// un media_id, hay que pedirle la URL temporal y descargarlo), y lo sube a
// Cloudinary para tener una URL pública permanente que el panel pueda mostrar.
function descargarMediaDeMetaYSubir(mediaId, esVideo) {
  return axios.get(
    'https://graph.facebook.com/v25.0/' + mediaId,
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN } }
  ).then(function(resp) {
    var urlTemporal = resp.data.url;
    var mimetype = resp.data.mime_type || 'application/octet-stream';
    return axios.get(urlTemporal, {
      headers: { 'Authorization': 'Bearer ' + META_API_TOKEN },
      responseType: 'arraybuffer'
    }).then(function(archivoResp) {
      return subirACloudinary(Buffer.from(archivoResp.data), mimetype, esVideo);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 NUEVO (25 jun): envío de plantillas aprobadas por Meta.
// A diferencia de enviarMensaje() (texto libre, que SOLO funciona dentro de la
// ventana de 24h desde el último mensaje del lead), las plantillas SÍ pueden
// reabrir la conversación aunque hayan pasado días. Se usa específicamente
// para los seguimientos automáticos (cron de cada hora y la reactivación de
// 12pm/7pm), que son mensajes "en frío" donde no sabemos si la ventana sigue
// abierta. Una vez el lead responde a la plantilla, la ventana de 24h se
// reabre y Olivia puede volver a usar texto libre normalmente.
// ═══════════════════════════════════════════════════════════════════════════
function enviarPlantilla(to, nombrePlantilla, codigoIdioma) {
  return axios.post(
    'https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages',
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: { name: nombrePlantilla, language: { code: codigoIdioma || 'es' } }
    },
    { headers: { 'Authorization': 'Bearer ' + META_API_TOKEN, 'Content-Type': 'application/json' } }
  ).then(function() {
    console.log('Plantilla "' + nombrePlantilla + '" enviada a ' + to);
  }).catch(function(error) {
    console.error('Error enviando plantilla:', error.response ? JSON.stringify(error.response.data) : error.message);
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
    console.error('Error mensaje:', error.message);
  });
}

// 🆕 FASE 1A, PASO 11 — el arranque real del servidor (conectar a Postgres y
// escuchar el puerto) solo debe pasar cuando este archivo se ejecuta
// directamente (`node whatsapp_agent.js` / `npm start`), NO cuando un
// archivo de pruebas hace `require(...)` para usar las funciones internas.
// Sin este guard, cada `require` desde una prueba abriría un servidor HTTP
// real de más. No cambia nada del comportamiento en producción: Railway
// sigue arrancando con `node whatsapp_agent.js` (ver Procfile), que sí
// cumple `require.main === module`.
if (require.main === module) {
  inicializarBD().then(function() {
    // 🆕 ETAPA 0: sin await a propósito — un fallo o demora en Graph API
    // nunca debe retrasar ni bloquear app.listen() ni el resto del servidor.
    obtenerPageAccessToken();
    app.listen(PORT, function() {
      console.log('Agente Lili V10 (PostgreSQL) en puerto ' + PORT);
      console.log('🔎 Verificación LILI_NUMERO: "' + LILI_NUMERO + '" (longitud: ' + (LILI_NUMERO ? LILI_NUMERO.length : 0) + ' caracteres) — compara esto con tu número real, sin +, sin espacios');
      console.log('🚩 COTIZADOR_REPISAS_V2_ENABLED = "' + process.env.COTIZADOR_REPISAS_V2_ENABLED + '" (tipo: ' + typeof process.env.COTIZADOR_REPISAS_V2_ENABLED + ', longitud: ' + (process.env.COTIZADOR_REPISAS_V2_ENABLED ? process.env.COTIZADOR_REPISAS_V2_ENABLED.length : 0) + ') — cotizadorRepisasV2Habilitado() = ' + cotizadorRepisasV2Habilitado());
    });
  });
}

// module.exports sigue siendo `app` para no romper nada que ya dependa de
// requerir este archivo y obtener el Express app directamente (ej. si algo
// externo ya lo hacía así) — las funciones internas nuevas que las pruebas
// de la Fase 1A necesitan se cuelgan como propiedades del mismo `app`, en
// vez de cambiar la forma del export.
app.inicializarBD = inicializarBD;
app.pool = pool;
app.conversaciones = conversaciones;
app.pausados = pausados;
app.procesando = procesando;
app.seguimientos = seguimientos;
app.agregarMensaje = agregarMensaje;
app.obtenerOCrearLead = obtenerOCrearLead;
app.tipoDeMensajeEsManejado = tipoDeMensajeEsManejado;
app.resolverNumeroRemitente = resolverNumeroRemitente;
app.reclamarLockProcesando = reclamarLockProcesando;
app.getMensajeSeguimiento = getMensajeSeguimiento;
app.mensajeReactivacion = mensajeReactivacion;
app.infoProductoSeguimiento = infoProductoSeguimiento;
app.activarSeguimiento = activarSeguimiento;
app.guardarSeguimiento = guardarSeguimiento;
app.detectarMensajeDuplicado = detectarMensajeDuplicado;
app.detectarIntencionCompraFormulario = detectarIntencionCompraFormulario;
app.ventanaReactivacion = ventanaReactivacion;
app.obtenerIntencionCompraLead = obtenerIntencionCompraLead;
app.liberarLockSiLoReclamamos = liberarLockSiLoReclamamos;
app.capturarMensajeCRM = capturarMensajeCRM;
app.capturarReferral = capturarReferral;
app.manejarEventoLeadgen = manejarEventoLeadgen;
app.obtenerPageAccessToken = obtenerPageAccessToken;
app.extraerTelefonoDeFieldData = extraerTelefonoDeFieldData;
app.registrarEventoLead = registrarEventoLead;
app.obtenerFormularioVinculadoReciente = obtenerFormularioVinculadoReciente;
app.formatearRespuestasFormulario = formatearRespuestasFormulario;
app.detectarProductoFormulario = detectarProductoFormulario;
app.detectarProductoPorTexto = detectarProductoPorTexto;
app.detectarProductoDesdeReferral = detectarProductoDesdeReferral;
app.formatearContextoReferral = formatearContextoReferral;
app.construirReferralParaContexto = construirReferralParaContexto;
app.resolverPrecioRepisa = resolverPrecioRepisa;
app.calcularPrecioRepisaDesdeFormula = calcularPrecioRepisaDesdeFormula;
app.clasificarTamanoRepisa = clasificarTamanoRepisa;
app.elegibleParaFormulaRepisa = elegibleParaFormulaRepisa;
app.detectarCotizacionRepisaDesdeContexto = detectarCotizacionRepisaDesdeContexto;
app.parsearCsvPreciosRepisas = parsearCsvPreciosRepisas;
app.calcularRequiereAprobacionDescuento = calcularRequiereAprobacionDescuento;
app.construirCatalogoRepisasV2 = construirCatalogoRepisasV2;
app.sembrarPreciosRepisas = sembrarPreciosRepisas;
app.extraerTagCotizarRepisa = extraerTagCotizarRepisa;
app.quitarTagCotizarRepisa = quitarTagCotizarRepisa;
app.detectarProductoParaFotos = detectarProductoParaFotos;
app.FOTOS_POR_PRODUCTO = FOTOS_POR_PRODUCTO;
app.PRODUCTO_FOTOS_FALLBACK = PRODUCTO_FOTOS_FALLBACK;
app.solicitudExplicitaFotos = solicitudExplicitaFotos;
app.solicitudFotoDetalleEspecifico = solicitudFotoDetalleEspecifico;
app.resolverProductoParaFotos = resolverProductoParaFotos;
app.obtenerProductoPersistidoLead = obtenerProductoPersistidoLead;
app.guardarProductoPersistidoLead = guardarProductoPersistidoLead;
app.fotosParaProducto = fotosParaProducto;
app.seleccionarFotosSaludo = seleccionarFotosSaludo;
app.seleccionarFotosExtra = seleccionarFotosExtra;
app.__setPreciosRepisasParaPruebas = function(filas) { preciosRepisas = filas; };
app.procesarMensaje = procesarMensaje;
app.manejarCotizacionRepisa = manejarCotizacionRepisa;
app.escalarCotizacionSinPrecio = escalarCotizacionSinPrecio;
// Solo para pruebas: permite inyectar un pool simulado. Nunca se llama en
// producción (Railway arranca con `node whatsapp_agent.js`, no hace `require`
// de este archivo desde otro módulo).
app.__setPoolParaPruebas = function(poolSimulado) { pool = poolSimulado; };
// Solo para pruebas: permite inyectar un stub de llamarClaude, para probar
// el flujo de cotización (Fase 5) sin hacer una llamada real a Anthropic.
app.__setLlamarClaudeParaPruebas = function(fn) { llamarClaude = fn; };
app.getSystemPrompt = getSystemPrompt;
app.cotizadorRepisasV2Habilitado = cotizadorRepisasV2Habilitado;
app.reactivacion1219Habilitada = reactivacion1219Habilitada;
app.respuestaPrometeEnvioGratisSinAprobar = respuestaPrometeEnvioGratisSinAprobar;
// Solo para pruebas: permite simular un producto con envío gratis aprobado
// sin tocar la lista real (vacía en producción salvo que Lili apruebe un caso).
app.__setProductosConEnvioGratisAprobadoParaPruebas = function(lista) { PRODUCTOS_CON_ENVIO_GRATIS_APROBADO = lista; };

module.exports = app;
