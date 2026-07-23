// Diagnóstico puntual: muestra el/los lead_form_submissions más recientes,
// con su field_data completo (nombres Y valores reales de Meta), para
// validar detectarProductoFormulario() contra un payload real.
//
// Uso: DATABASE_URL="postgresql://...tu_url_publica..." node scripts/ver_ultimo_formulario.js

const { Client } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ Falta DATABASE_URL. Uso: DATABASE_URL="postgresql://..." node scripts/ver_ultimo_formulario.js');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const res = await client.query(
    'SELECT id, leadgen_id, page_id, form_id, ad_id, estado_vinculacion, lead_id, field_data, created_at ' +
    'FROM lead_form_submissions ORDER BY created_at DESC LIMIT 5'
  );

  if (res.rows.length === 0) {
    console.log('⚠️ No hay ninguna fila en lead_form_submissions todavía. ¿Ya generaste el lead de prueba y esperaste unos segundos?');
  } else {
    res.rows.forEach(function(fila, i) {
      console.log('\n─── Submission #' + (i + 1) + ' (id=' + fila.id + ') ───');
      console.log('leadgen_id:', fila.leadgen_id);
      console.log('form_id:', fila.form_id, '| ad_id:', fila.ad_id, '| page_id:', fila.page_id);
      console.log('estado_vinculacion:', fila.estado_vinculacion, '| lead_id:', fila.lead_id);
      console.log('created_at:', fila.created_at);
      console.log('field_data (nombres y valores reales de Meta):');
      console.log(JSON.stringify(fila.field_data, null, 2));
    });
  }

  await client.end();
}

main().catch(function(e) {
  console.error('❌ Falló la consulta:', e.message);
  process.exit(1);
});
