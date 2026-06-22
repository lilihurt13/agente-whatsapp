# 🪵 Agente WhatsApp - Hecho por Lili

Agente automático para responder mensajes de WhatsApp Business usando la API de Meta.

## 📋 Requisitos

- Node.js >=18.0.0
- Variables de entorno configuradas
- Número de WhatsApp Business registrado en Meta

## 🚀 Instalación Local

```bash
npm install
```

## ⚙️ Configuración

1. Copia `.env.example` a `.env`
2. Llena tus credenciales (ver `.env.example` para la lista completa: `META_API_TOKEN`, `PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `CONTROL_TOKEN`, `LILI_NUMERO`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`)
3. Ninguno de estos valores debe quedar escrito en el código — todos se leen de variables de entorno. En Railway se configuran en la pestaña *Variables* del servicio.

## ▶️ Ejecutar

```bash
npm start
```

## 🔗 Webhook en Meta

**URL**: `https://hospitable-appreciation-production-8e5b.up.railway.app/webhook`
**Token**: el valor que configures en `WEBHOOK_VERIFY_TOKEN`

Configura esto en Meta Developers → Tu App → Webhooks. Además, copia el **App Secret** de tu app (Configuración → Básica) en la variable `META_APP_SECRET` — el servidor lo usa para verificar que cada mensaje entrante venga realmente de Meta.

## 📝 Estructura

- `whatsapp_agent.js` - Servidor principal
- `package.json` - Dependencias
- `Procfile` - Configuración para Railway
- `.env.example` - Variables de entorno (template)

## ✅ Estado

- ✅ Webhook verification
- ✅ Message receiving
- ✅ Message sending
- ✅ Basic responses

## 📞 Soporte

Para cambios, edita `whatsapp_agent.js` y haz push a GitHub. Railway redeploy automáticamente.
