# Cotizador de repisas v2 — estado y plan de integración

## 🚨 REGLA DURA antes de cualquier push a main

**La Fase 4 (instrucción del tag en `getSystemPrompt()`) y la Fase 5
(interceptar el tag + segunda llamada a Claude) deben mergearse juntas a
`main`, NUNCA la Fase 4 sola.** Si se desplegara la Fase 4 sin la Fase 5,
Claude empezaría a emitir `[COTIZAR_REPISA:...]` en producción sin que
nada lo intercepte — el tag llegaría **crudo y visible al cliente** por
WhatsApp. Verificar esto explícitamente antes de autorizar cualquier
push que incluya el bloque de `getSystemPrompt()` de la Fase 4.

## ⚠️ Estado actual: backend probado, NO conectado al flujo conversacional

Este commit deja lista la capa de datos y cálculo del cotizador v2:
`precios_repisas` (tabla + siembra idempotente desde
`data/precios_repisas_v2.csv`), carga en memoria, `construirCatalogoRepisasV2()`,
y `resolverPrecioRepisa()` (función pura, 14 pruebas nuevas, todas contra
datos reales del CSV).

**`resolverPrecioRepisa()` todavía no se llama desde ningún punto del
webhook ni de `procesarMensaje()`.** El catálogo v1 de repisas dentro de
`getSystemPrompt()` sigue siendo el que Olivia usa hoy en producción — nada
del comportamiento conversacional cambió con este commit. Es intencional:
Lili pidió dejar esta base "segura y probada" como paso aislado antes de
tocar el flujo real.

## Plan de integración aprobado (para la próxima sesión/rama)

**Enfoque: tag interno `[COTIZAR_REPISA:...]`**, mismo patrón que ya usan
`[ESCALAR]` y `[FOTOS_EXTRA]` hoy en el código.

Flujo:
1. Claude conversa normalmente. Cuando detecta que ya tiene datos
   suficientes para cotizar una repisa, **no calcula ni inventa el
   precio** — emite un tag interno estructurado, ej.:
   `[COTIZAR_REPISA:largo=70,prof=20,cantidad=1,ciudad=Medellín,modalidad=instalado_medellin]`
2. El tag es interno — el sistema lo elimina antes de que el cliente lo
   vea, igual que ya hace con `[ESCALAR]`/`[FOTOS_EXTRA]`.
3. El backend intercepta el tag, parsea los parámetros, y llama a
   `resolverPrecioRepisa()`.
4. Se hace una **segunda llamada a Claude en el mismo turno**, con el
   resultado de `resolverPrecioRepisa()` ya inyectado en el contexto, para
   que redacte el mensaje final al cliente. Claude solo redacta, nunca
   calcula.
5. Si faltan datos (largo, profundidad, ciudad, cantidad, o si es
   Medellín-instalado vs envío), Claude NO emite el tag — pregunta lo que
   falte primero.
6. Si `resolverPrecioRepisa()` devuelve `tipoResolucion: "requiere_aprobacion"`,
   Claude no da precio cerrado — responde algo tipo *"Esa medida es más
   personalizada. Déjame confirmarla con Lili para darte el valor
   exacto."* y escala a Liliana (mismo mecanismo `[ESCALAR]` existente).

**Valores de `modalidad` para esta primera integración** (más simples que
los 3 modos originales, decisión de Lili para esta fase):
- `instalado_medellin` — por defecto si el cliente está en Medellín/área
  cercana (instalación incluida).
- `envio_nacional` — cliente fuera de Medellín, sin instalación.
- `recogida` — solo si el cliente dice explícitamente que recoge; siempre
  resuelve a `requiere_aprobacion` (sin desglose de transporte/buffer en
  el CSV para calcularlo automático — ver `resolverPrecioRepisa()`,
  cualquier modalidad distinta de `instalado`/`enviado` ya escala hoy).

## Qué NO cambia con esta integración futura
- `notificarLili()`, protecciones de `LILI_NUMERO`, tabla de envíos por
  ciudad existente — sin tocar.
- El resto de `getSystemPrompt()` (otros productos, reglas de escalación,
  etc.) — sin tocar, salvo la sección específica de precios de repisas que
  se reemplaza por el catálogo v2.
- La regla de "Claude nunca calcula ni inventa precios" — se mantiene y de
  hecho se refuerza (ahora ni siquiera interpola en el prompt, todo pasa
  por `resolverPrecioRepisa()`).
