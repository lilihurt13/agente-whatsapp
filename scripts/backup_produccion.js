// Respaldo lógico manual de producción, previo a fusionar la Fase 1A.
// No usa pg_dump (no disponible en este entorno) — conecta directamente con
// el paquete `pg` ya instalado y exporta cada tabla a un archivo JSON con
// fecha, dentro de backups/ (carpeta ignorada por git).
//
// Uso: DATABASE_URL="postgresql://...tu_url_publica..." node scripts/backup_produccion.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TABLAS = [
  'conversaciones', 'pausados', 'seguimientos', 'ajustes', 'notas',
  'leads', 'messages', 'lead_events', 'lead_form_submissions'
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ Falta DATABASE_URL. Uso: DATABASE_URL="postgresql://..." node scripts/backup_produccion.js');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✅ Conectado a la base de datos.');

  const ahora = new Date().toISOString().replace(/[:.]/g, '-');
  const carpeta = path.join(__dirname, '..', 'backups', 'backup_' + ahora);
  fs.mkdirSync(carpeta, { recursive: true });

  const resumen = {};
  for (const tabla of TABLAS) {
    try {
      const res = await client.query('SELECT * FROM ' + tabla);
      fs.writeFileSync(
        path.join(carpeta, tabla + '.json'),
        JSON.stringify(res.rows, null, 2)
      );
      resumen[tabla] = res.rows.length;
      console.log('  ✔ ' + tabla + ': ' + res.rows.length + ' filas guardadas');
    } catch (e) {
      resumen[tabla] = 'ERROR: ' + e.message;
      console.error('  ⚠️ ' + tabla + ': ' + e.message + ' (probablemente la tabla aún no existe — normal si es la primera vez)');
    }
  }

  fs.writeFileSync(path.join(carpeta, '_resumen.json'), JSON.stringify(resumen, null, 2));
  await client.end();

  console.log('');
  console.log('✅ Respaldo completo en: ' + carpeta);
  console.log('Resumen:', resumen);
}

main().catch(function(e) {
  console.error('❌ Falló el respaldo:', e.message);
  process.exit(1);
});
