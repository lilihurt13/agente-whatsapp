// Diagnóstico puntual: muestra el referral_data guardado en la base de
// datos para un lead específico (por whatsapp_phone), para confirmar qué
// llegó realmente vs. lo que Olivia usó al responder.
//
// Uso: DATABASE_URL="postgresql://...tu_url_publica..." node scripts/ver_referral_lead.js 573138910346

const { Client } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const numero = process.argv[2];
  if (!databaseUrl || !numero) {
    console.error('❌ Uso: DATABASE_URL="postgresql://..." node scripts/ver_referral_lead.js <numero>');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const res = await client.query(
    'SELECT id, whatsapp_phone, source, campaign_id, ad_id, referral_data, created_at, updated_at ' +
    'FROM leads WHERE whatsapp_phone = $1',
    [numero]
  );

  if (res.rows.length === 0) {
    console.log('⚠️ No hay ningún lead con ese número.');
  } else {
    const lead = res.rows[0];
    console.log('lead id:', lead.id, '| source:', lead.source, '| campaign_id:', lead.campaign_id, '| ad_id:', lead.ad_id);
    console.log('created_at:', lead.created_at, '| updated_at:', lead.updated_at);
    console.log('referral_data guardado en la BD ahora mismo:');
    console.log(JSON.stringify(lead.referral_data, null, 2));
  }

  await client.end();
}

main().catch(function(e) {
  console.error('❌ Falló la consulta:', e.message);
  process.exit(1);
});
