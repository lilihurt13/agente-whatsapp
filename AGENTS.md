# Instrucciones obligatorias para trabajar en Olivia

Estas reglas aplican a cualquier agente o asistente que trabaje en este
repositorio, sin importar la herramienta utilizada.

## Antes de realizar cambios

1. Leer completo `docs/OLIVIA_DOCUMENTO_MAESTRO.md`.
2. Leer `docs/PENDIENTES.md`.
3. Leer los documentos técnicos relacionados con la tarea.
4. Revisar la rama actual, `git status` y los cambios sin confirmar.
5. No asumir que una hipótesis documentada ya fue confirmada: comprobarla con
   código, pruebas, logs o datos cuando corresponda.

## Durante el trabajo

1. Trabajar en una rama distinta de `main`.
2. No hacer push a `main` ni desplegar sin autorización explícita de Lili.
3. No modificar reglas de precios, cotizaciones, Meta/WhatsApp, memoria,
   escalamiento o control humano sin pruebas proporcionales al riesgo.
4. Mantener separados diagnóstico, implementación y despliegue.
5. Nunca incluir tokens, contraseñas ni variables de entorno reales en código,
   documentación, commits o conversaciones.

## Antes de cerrar

1. Ejecutar las pruebas correspondientes y comunicar el resultado.
2. Actualizar `docs/OLIVIA_DOCUMENTO_MAESTRO.md` si hubo cualquier cambio,
   hallazgo o decisión relevante, incluyendo comportamiento, arquitectura,
   esquema de datos, prompts, integraciones, pruebas, despliegues o pendientes.
3. Revisar `docs/PENDIENTES.md` y actualizarlo cuando se agregue, cambie o
   resuelva un pendiente. Si no necesita cambios, indicarlo en el resumen.
4. Incluir la documentación actualizada en el mismo commit o pull request que
   el cambio relacionado.
5. Entregar un resumen claro de archivos modificados, pruebas, riesgos,
   pendientes y estado de commit/push/despliegue.

## Regla de documentación verificable

Los pull requests que cambien archivos funcionales críticos deben incluir una
actualización de `docs/OLIVIA_DOCUMENTO_MAESTRO.md`. La comprobación automática
vive en `.github/workflows/verificar-documentacion.yml`.

