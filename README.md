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
2. Llena tus credenciales:
   - `META_API_TOKEN`: Token de acceso de Meta
   - `PHONE_NUMBER_ID`: ID de tu número WhatsApp
   - `WABA_ID`: ID de workspace

## ▶️ Ejecutar

```bash
npm start
```

## 🔗 Webhook en Meta

**URL**: `https://hospitable-appreciation-production-8e5b.up.railway.app/webhook`
**Token**: `hecho_por_lili_2026`

Configura esto en Meta Developers → Tu App → Webhooks

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
