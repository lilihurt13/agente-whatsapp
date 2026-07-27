# Cotizador de repisas v2 — estado y plan de integración

## ✅ Estado a 26 jul 2026: Fases 1-5 implementadas, detrás de un feature flag apagado por defecto

Todo el flujo (backend + parser del tag + intercepción + segunda llamada
a Claude) está implementado y probado (68 pruebas). **Nada de esto está
activo en producción todavía** — controlado por la variable de entorno
`COTIZADOR_REPISAS_V2_ENABLED` (ver sección de flag más abajo), que hoy
está apagada (ausente/`false`) en cualquier despliegue. Con el flag
apagado, `getSystemPrompt()` es **exactamente igual** al de antes de
esta integración — cero cambio de comportamiento, verificado por prueba
automatizada (`getSystemPrompt — con el flag apagado, el prompt NO
menciona el tag del cotizador`).

## 🚩 Feature flag: `COTIZADOR_REPISAS_V2_ENABLED`

- **Apagado por defecto** (variable ausente o distinta de `"true"`).
- Controla únicamente si el bloque de instrucciones del tag
  `[COTIZAR_REPISA:...]` se agrega a `getSystemPrompt()`. Con el flag
  apagado, Claude nunca ve esa instrucción, nunca emite el tag, y todo el
  código de intercepción (`manejarCotizacionRepisa()`, etc.) queda
  simplemente sin usarse — inerte, no se ejecuta nunca.
- Se activa poniendo `COTIZADOR_REPISAS_V2_ENABLED=true` en las
  variables de entorno de Railway → requiere **redeploy** para tomar
  efecto (no es un flag de runtime dinámico).
- **Esta es la forma seleccionada de cumplir la regla dura** de que la
  Fase 4 (instrucción del tag) y la Fase 5 (intercepción) se despliegan
  juntas sin riesgo: con el flag apagado, se puede mergear todo el
  código a `main` de forma segura, y activarlo después, cuando se quiera
  probar con un lead real — sin necesitar un deploy nuevo para "activar"
  ni otro para "desactivar" si algo sale mal (solo cambiar la variable y
  redeployar, mucho más rápido que un revert de código).

## Qué hace el flujo completo (con el flag encendido)

1. Claude conversa normalmente. Cuando detecta que ya tiene los 4 datos
   (largo, profundidad, ciudad, cantidad) Y cantidad=1, emite
   `[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]`
   — nunca calcula el precio él mismo.
2. `extraerTagCotizarRepisa()` parsea el tag y traduce la modalidad
   (`instalado_medellin`→`instalado`, `envio_nacional`→`enviado`,
   `recogida` sin traducir).
3. `manejarCotizacionRepisa()` verifica elegibilidad (cantidad=1, defensa
   en profundidad), llama a `resolverPrecioRepisa()` (nunca Claude), y si
   hay precio resuelto hace una **segunda llamada a Claude** con el precio
   ya inyectado en el prompt para que redacte el mensaje final.
4. Solo el texto de esa segunda llamada pasa por `agregarMensaje()` — la
   respuesta cruda de la primera llamada (con el tag) nunca se guarda.
5. Cualquier falla en el camino (cantidad>1, `requiere_aprobacion`, la
   segunda llamada a Claude falla) cae en una única ruta de escalamiento
   segura (`escalarCotizacionSinPrecio()`): mensaje fijo al cliente +
   `notificarLili()` + `marcarPausado()` — el cliente nunca se queda sin
   respuesta ni ve el tag crudo.

## Qué NO cambia
- `notificarLili()`, protecciones de `LILI_NUMERO`, tabla de envíos por
  ciudad existente — sin tocar.
- El catálogo v1 de repisas sigue siendo el que usa Olivia con el flag
  apagado — no se reemplazó, coexiste (el bloque nuevo tiene prioridad
  explícita en el texto del prompt cuando el flag está encendido).
- La regla de "Claude nunca calcula ni inventa precios" — se mantiene y
  se refuerza.

## Cómo probar con un lead real, de forma segura

1. Confirmar que el commit de la Fase 5 (con el flag) ya está en `main`
   y desplegado — con el flag apagado, esto no cambia nada visible.
2. En Railway → servicio web → Variables, agregar
   `COTIZADOR_REPISAS_V2_ENABLED=true`. Esto dispara un redeploy.
3. Probar con un número de WhatsApp propio (no un cliente real
   desprevenido) una conversación completa dando largo, profundidad,
   ciudad y cantidad=1 de una repisa.
4. Revisar en los logs de Railway las líneas `💲 Tag COTIZAR_REPISA
   detectado...` y `💲✅ Cotización de repisa resuelta y enviada...` (o
   `💲⏭️ ... escalada...` si tocó escalamiento) para confirmar el flujo.
5. Si algo sale mal: volver a poner `COTIZADOR_REPISAS_V2_ENABLED=false`
   (o borrar la variable) en Railway y redeployar — vuelve al
   comportamiento de hoy sin necesitar un revert de código.
