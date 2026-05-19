#!/usr/bin/env node

/**
 * ANALYTICS Y REPORTS - Hecho por Lili
 * 
 * Analiza:
 * - Conversión de leads (frío → tibio → caliente)
 * - Productos más pedidos
 * - Tiempos de respuesta
 * - Patrones de preguntas
 */

const fs = require('fs');
const path = require('path');

class LeadAnalytics {
  constructor(leadsData) {
    this.leads = leadsData;
  }

  generateReport() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║           📊 REPORTE DE LEADS - HECHO POR LILI 🪵              ║
╚════════════════════════════════════════════════════════════════╝
    `);

    const stats = {
      total: Object.keys(this.leads).length,
      hot: 0,
      warm: 0,
      cold: 0,
      productos: {},
      tiempos_respuesta: [],
      conversion_rate: 0
    };

    // Analizar por temperatura
    Object.entries(this.leads).forEach(([phone, data]) => {
      if (data.temperatura === 'caliente') stats.hot++;
      else if (data.temperatura === 'tibio') stats.warm++;
      else stats.cold++;

      // Contar productos
      if (data.producto) {
        stats.productos[data.producto] = (stats.productos[data.producto] || 0) + 1;
      }

      // Calcular tiempo de respuesta promedio
      if (data.mensajes && data.mensajes.length > 1) {
        const primer = new Date(data.mensajes[0].timestamp);
        const ultimo = new Date(data.mensajes[data.mensajes.length - 1].timestamp);
        const minutos = (ultimo - primer) / (1000 * 60);
        stats.tiempos_respuesta.push(minutos);
      }
    });

    // Calcular tasa de conversión (de frío a tibio+)
    if (stats.total > 0) {
      stats.conversion_rate = ((stats.warm + stats.hot) / stats.total * 100).toFixed(1);
    }

    // Mostrar stats
    console.log(`
📈 ESTADÍSTICAS GENERALES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total de leads:                ${stats.total}
🔥 Calientes (listos para cerrar): ${stats.hot}
🟡 Tibios (en conversación):       ${stats.warm}
❄️  Fríos (sin respuesta):          ${stats.cold}

Tasa de conversión:            ${stats.conversion_rate}%
    `);

    // Productos más pedidos
    console.log(`
🏪 PRODUCTOS MÁS PEDIDOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    Object.entries(stats.productos)
      .sort((a, b) => b[1] - a[1])
      .forEach(([producto, cantidad]) => {
        const barra = '█'.repeat(Math.ceil(cantidad / stats.total * 20));
        console.log(`${producto.padEnd(25)} ${barra} ${cantidad}`);
      });

    // Tiempos de respuesta
    if (stats.tiempos_respuesta.length > 0) {
      const promedio = stats.tiempos_respuesta.reduce((a, b) => a + b, 0) / stats.tiempos_respuesta.length;
      console.log(`
⏱️  TIEMPOS DE RESPUESTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Promedio de minutos entre primer y último mensaje: ${promedio.toFixed(1)} min
Más rápido: ${Math.min(...stats.tiempos_respuesta).toFixed(1)} min
Más lento: ${Math.max(...stats.tiempos_respuesta).toFixed(1)} min
      `);
    }

    // Recomendaciones
    console.log(`
💡 RECOMENDACIONES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    if (stats.cold / stats.total > 0.5) {
      console.log(`⚠️  Muchos leads fríos (${(stats.cold / stats.total * 100).toFixed(0)}%)`);
      console.log(`   → Mejorar el primer mensaje del agente`);
      console.log(`   → Pedir foto del espacio más temprano`);
      console.log(`   → Agregar más social proof\n`);
    }

    if (stats.hot === 0 && stats.warm > 0) {
      console.log(`⚠️  Tienes leads tibios pero ninguno caliente`);
      console.log(`   → El agente debería escalar más agresivamente`);
      console.log(`   → Tú deberías cerrar estos leads directamente\n`);
    }

    if (stats.conversion_rate < 30) {
      console.log(`⚠️  Baja tasa de conversión (${stats.conversion_rate}%)`);
      console.log(`   → Revisa las respuestas del agente`);
      console.log(`   → ¿Está pidiendo foto del espacio a tiempo?`);
      console.log(`   → ¿Está manejando objeciones correctamente?\n`);
    }

    // Leads a acelerar
    const hotLeads = Object.entries(this.leads)
      .filter(([_, data]) => data.temperatura === 'caliente')
      .map(([phone, data]) => ({
        phone,
        producto: data.producto,
        etapa: data.etapa,
        tiempo: Math.round((new Date() - new Date(data.primer_mensaje)) / (1000 * 60))
      }));

    if (hotLeads.length > 0) {
      console.log(`
🚀 LEADS LISTOS PARA CERRAR (CALIENTES)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `);
      hotLeads.forEach(lead => {
        console.log(`📞 ${lead.phone}`);
        console.log(`   Producto: ${lead.producto}`);
        console.log(`   Tiempo en conversación: ${lead.tiempo} minutos`);
        console.log(`   ACCIÓN: Contacta directamente ahora\n`);
      });
    }

    console.log(`
════════════════════════════════════════════════════════════════
Reporte generado: ${new Date().toLocaleString('es-ES')}
    `);
  }
}

// Si se ejecuta desde CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args[0] === 'report' || !args[0]) {
    // Cargar datos simulados o reales
    const mockData = {
      '573101234567': {
        primer_mensaje: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 días atrás
        temperatura: 'caliente',
        producto: 'escritorio_flotante',
        etapa: 'cotizado',
        mensajes: [
          { timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), text: 'Hola, me interesa' },
          { timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), text: '¿Cuánto vale?' }
        ]
      },
      '573105555666': {
        primer_mensaje: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        temperatura: 'tibio',
        producto: 'repisa_flotante',
        etapa: 'calificado',
        mensajes: [
          { timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), text: 'Hola' },
          { timestamp: new Date(Date.now() - 20 * 60 * 1000), text: '¿Me envías medidas?' }
        ]
      },
      '573109999888': {
        primer_mensaje: new Date(Date.now() - 5 * 60 * 60 * 1000),
        temperatura: 'frio',
        producto: 'escritorio_flotante',
        etapa: 'inicial',
        mensajes: [
          { timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000), text: 'Me interesa' }
        ]
      }
    };

    const analytics = new LeadAnalytics(mockData);
    analytics.generateReport();
  }
}

module.exports = LeadAnalytics;
