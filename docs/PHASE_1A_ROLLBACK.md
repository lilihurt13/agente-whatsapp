# Fase 1A — Mecanismo de Respaldo y Rollback

Este documento describe cómo respaldar el estado actual antes de aplicar
los cambios de la Fase 1A (captura urgente, trazabilidad e idempotencia),
y cómo revertirlos si algo sale mal. Ningún comando de este documento se
ejecuta automáticamente — todos son manuales y requieren que Lili los
corra explícitamente contra la base de datos de producción.

## 1. Alcance del cambio

La Fase 1A **no modifica, renombra ni elimina** ninguna de las 5 tablas
existentes (`conversaciones`, `pausados`, `seguimientos`, `ajustes`,
`notas`), ni ninguna fila dentro de ellas. Solo añade tablas nuevas:

- `leads`
- `messages`
- `lead_events`
- `webhook_events` (si se aprueba, ver sección 8 del prompt de Fase 1A)

Por eso, en sentido estricto, no hay "tablas modificadas" que respaldar.
El respaldo que se describe abajo es una precaución adicional antes de
tocar la base de datos de producción, no un requisito impuesto por el
cambio en sí.

## 2. Respaldo antes de aplicar las migraciones

### 2.1 Railway NO tiene backups automáticos en el plan actual

**Confirmado por Lili (22 jul 2026):** el servicio de Postgres en Railway
muestra "No Backups" — los backups automáticos requieren plan Pro. Esto
significa que **el `pg_dump` manual de la sección 2.2 no es una precaución
redundante — es el único respaldo que existirá antes de aplicar las
migraciones de la Fase 1A.** Debe ejecutarse sin excepción antes de correr
cualquier `CREATE TABLE` nuevo contra la base de datos de producción.

### 2.2 Backup lógico manual (pg_dump)

Ejecutar desde una máquina con acceso a `DATABASE_URL` de producción
(esta copia local del repo no tiene esa variable — no se puede ejecutar
desde aquí):

```bash
# Dump completo de la base de datos (recomendado, más simple)
pg_dump "$DATABASE_URL" -Fc -f "backup_pre_fase1a_$(date +%Y%m%d_%H%M).dump"

# Alternativa: dump solo de las tablas existentes que la Fase 1A rodea
pg_dump "$DATABASE_URL" -Fc \
  -t conversaciones -t pausados -t seguimientos -t ajustes -t notas \
  -f "backup_tablas_actuales_$(date +%Y%m%d_%H%M).dump"
```

Guardar el archivo `.dump` resultante fuera del repositorio (no debe
subirse a Git — puede contener datos personales de leads).

### 2.3 Restauración desde ese backup, si hiciera falta

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" "backup_pre_fase1a_XXXXXXXX.dump"
```

`--clean --if-exists` sobrescribe únicamente las tablas presentes en el
dump; no toca tablas que no estén incluidas en el archivo.

## 3. Rollback de las tablas nuevas (si la Fase 1A necesita revertirse)

Las tablas nuevas son aditivas y no tienen llaves foráneas entrantes desde
las tablas antiguas, así que pueden eliminarse sin afectar
`conversaciones`, `pausados`, `seguimientos`, `ajustes` ni `notas`:

```sql
-- Ejecutar manualmente, solo si Lili autoriza revertir la Fase 1A por completo
DROP TABLE IF EXISTS lead_events;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS webhook_events; -- si fue creada
```

Este bloque **no se incluye en ningún script que corra automáticamente al
arrancar el servidor** — es exclusivamente para ejecución manual.

## 4. Rollback de código

Como todo el trabajo vive en `feature/crm-phase-1a-capture` y `main` no se
toca en ningún momento, el rollback de código más simple es no hacer merge
de la rama. Si ya se hizo merge y hay que revertir:

```bash
git revert -m 1 <hash-del-merge-commit>
```

Railway seguiría desplegando `main` en su estado anterior sin necesidad de
tocar la base de datos, siempre que no se haya ejecutado el rollback SQL de
la sección 3 (las tablas nuevas simplemente quedan sin uso, sin romper
nada).

## 5. Qué NO hace este mecanismo

- No ejecuta ningún backup ni restauración automáticamente.
- No borra, trunca ni altera ninguna tabla existente en ningún escenario.
- No reemplaza los backups nativos de Railway, si existen — es un
  complemento puntual para este cambio específico.
