# Fase 1A — Estrategia de Pruebas (Sección 11, Casos A-H)

## Por qué `pg-mem` en vez de mockear `pool.query` a mano

Los Casos A-H no son pruebas de lógica JS aislada — la mitad de ellos
(especialmente C y F) existen específicamente para verificar **semántica
real de SQL**: que `INSERT ... ON CONFLICT (whatsapp_message_id) DO
NOTHING RETURNING id` efectivamente detecta un duplicado, y que el merge
`referral_data || $2::jsonb` efectivamente preserva claves previamente
confirmadas.

Un mock manual de `pool.query` (ej. un objeto en memoria con lógica
`if/else` escrita a mano simulando "si la clave ya existe, devuelve 0
filas") tiene un problema de fondo: el mock terminaría codificando **mi
propio entendimiento de qué hace la consulta**, no lo que la consulta
realmente hace. Si el SQL real tuviera un error — una columna equivocada
en el `ON CONFLICT`, una precedencia incorrecta en el operador JSONB `||`,
un tipo de dato mal casteado — el mock seguiría "pasando" porque nunca
ejecuta la consulta, solo simula el resultado que yo asumí. Es exactamente
la falsa confianza que este paso de pruebas busca evitar.

`pg-mem` resuelve esto porque **parsea y ejecuta la consulta SQL real**
contra un motor relacional en memoria (constraints `UNIQUE`, `ON
CONFLICT`, operadores JSONB, `COALESCE`, `RETURNING`, etc.) — un bug real
en el SQL se manifiesta como un error real o un resultado real
incorrecto, igual que pasaría contra Postgres de producción.

## Limitación reconocida

Ni `pg-mem` ni un mock a mano pueden probar una condición de carrera
**verdaderamente concurrente** (dos conexiones de red simultáneas reales)
sin una base de datos real con múltiples conexiones — eso queda fuera del
alcance razonable de pruebas unitarias. Lo que sí prueban los Casos C y F
es el escenario real que importa: la misma clave (`whatsapp_message_id` /
`leadgen_id`) llega dos veces de forma secuencial (reintento de webhook de
Meta), y la segunda vez se reconoce correctamente como duplicado.

## Alcance de la dependencia nueva

`pg-mem` se agrega **solo como `devDependency`** — nunca se carga en
producción, no cambia el árbol de dependencias que corre en Railway, y no
requiere reestructurar `whatsapp_agent.js` en múltiples módulos. El único
cambio en el archivo principal es exportar (`module.exports`) las
funciones ya existentes que las pruebas necesitan invocar directamente, y
envolver el arranque automático del servidor (`inicializarBD().then(() =>
app.listen(...))`) en un guard `require.main === module`, para que
requerir el archivo desde una prueba no levante el servidor real ni abra
una conexión de red.
