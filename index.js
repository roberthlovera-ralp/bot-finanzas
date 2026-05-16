require('dotenv').config({ debug: true });

// Detectar si está en Railway
const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT === 'production';

// ===== CONFIGURACIÓN PARA WHATSAPP =====
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = false;
// =======================================

// ===== VERIFICACIÓN DE VARIABLES =====
console.log('🔍 Verificando .env:');
console.log('SPREADSHEET_ID:', process.env.SPREADSHEET_ID ? '✅ CARGADO' : '❌ FALTA');
console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ CARGADO' : '❌ FALTA');
console.log('TU_NUMERO:', process.env.TU_NUMERO ? '✅ CARGADO' : '❌ FALTA');
console.log('=====================================');
// =====================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const schedule = require('node-schedule');
require('dotenv').config();

// ============================================
// CONFIGURACIÓN DE USUARIOS
// ============================================
const USUARIOS = {
    [process.env.TU_NUMERO + '@c.us']: { 
        nombre: 'ROBERTH',
        monedaPredeterminada: ['USD', 'PEN'] 
    },
    [process.env.NUMERO_ESPOSA + '@c.us']: { 
        nombre: 'ANAVERONICA',
        monedaPredeterminada: ['USD', 'PEN'] 
    },
    [process.env.NUMERO_HIJO + '@c.us']: {
        nombre: 'ROBERTHAEROWORLD',
        monedaPredeterminada: ['USD', 'PEN']
    }
};

// ============================================
// CATEGORÍAS
// ============================================
const CATEGORIAS = {
    '1': '🏠 Hogar / Servicios',
    '2': '🛒 Supermercado / Comida',
    '3': '🚗 Auto',
    '4': '🏥 Salud',
    '5': '👕 Compras Personales',
    '6': '🎢 Entretenimiento',
    '7': '📺 Suscripciones (Netflix, etc)',
    '8': '🚗 Seguro de Auto',
    '9': '💵 Conversión USD → PEN',
    '10': '💰 Ingreso'
};

const MONEDA_CATEGORIA = {
    '🏠 Hogar / Servicios': 'PEN',
    '🛒 Supermercado / Comida': 'PEN',
    '🚗 Auto': 'PEN',
    '🏥 Salud': 'PEN',
    '👕 Compras Personales': 'PEN',
    '🎢 Entretenimiento': 'PEN',
    '📺 Suscripciones (Netflix, etc)': 'USD',
    '🚗 Seguro de Auto': 'USD',
    '💵 Conversión USD → PEN': 'AMBAS',
    '💰 Ingreso': 'AMBAS'
};

let MODO_REGISTRO_LIBRE = true;
let PRESUPUESTOS = {};
const esperandoCategoria = new Map();

// ============================================
// INICIALIZAR APIs
// ============================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const sheets = google.sheets('v4');
const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
);

// ============================================
// FUNCIONES DE GOOGLE SHEETS
// ============================================
async function inicializarSheets() {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheets_ls = ['Gastos', 'Presupuestos', 'Alertas'];
    
    for (const sheet of sheets_ls) {
        try {
            await sheets.spreadsheets.values.get({
                auth,
                spreadsheetId,
                range: `${sheet}!A1`
            });
        } catch (e) {
            await sheets.spreadsheets.batchUpdate({
                auth,
                spreadsheetId,
                resource: {
                    requests: [{ addSheet: { properties: { title: sheet } } }]
                }
            });
            
            let headers = [];
            if (sheet === 'Gastos') {
                headers = ['Fecha', 'Usuario', 'Comercio', 'Monto', 'Moneda', 'Categoría'];
            } else if (sheet === 'Presupuestos') {
                headers = ['Categoría', 'Presupuesto Mensual', 'Moneda', 'Gastado', '% Usado'];
            } else if (sheet === 'Alertas') {
                headers = ['Fecha', 'Usuario', 'Categoría', 'Mensaje', 'Leída'];
            }
            
            await sheets.spreadsheets.values.update({
                auth,
                spreadsheetId,
                range: `${sheet}!A1:${String.fromCharCode(65+headers.length-1)}1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [headers] }
            });
        }
    }
}

async function guardarGasto(datos) {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const values = [[
        datos.fecha,
        datos.usuario,
        datos.comercio,
        datos.monto,
        datos.moneda,
        datos.categoria
    ]];
    
    await sheets.spreadsheets.values.append({
        auth,
        spreadsheetId,
        range: 'Gastos!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: { values }
    });
    
    if (!MODO_REGISTRO_LIBRE && PRESUPUESTOS[datos.categoria]) {
        PRESUPUESTOS[datos.categoria].gastado += parseFloat(datos.monto);
        await verificarAlertas(datos);
    }
    
    return true;
}

async function verificarAlertas(gasto) {
    const presupuesto = PRESUPUESTOS[gasto.categoria];
    if (!presupuesto || presupuesto.mensual === 0) return;
    
    const porcentaje = (presupuesto.gastado / presupuesto.mensual) * 100;
    let mensaje = null;
    
    if (porcentaje >= 100 && !presupuesto.alerta100) {
        mensaje = `🔴 ¡ALERTA! Has SUPERADO el presupuesto de ${gasto.categoria}\n📊 Gastado: ${gasto.moneda === 'USD' ? 'US$' : 'S/'} ${presupuesto.gastado.toFixed(2)} / ${presupuesto.mensual}`;
        presupuesto.alerta100 = true;
    } else if (porcentaje >= 80 && !presupuesto.alerta80) {
        mensaje = `⚠️ ATENCIÓN: Has alcanzado el 80% de tu presupuesto en ${gasto.categoria}\n📊 Gastado: ${gasto.moneda === 'USD' ? 'US$' : 'S/'} ${presupuesto.gastado.toFixed(2)} / ${presupuesto.mensual}`;
        presupuesto.alerta80 = true;
    }
    
    if (mensaje) {
        const telefono = Object.keys(USUARIOS).find(key => USUARIOS[key].nombre === gasto.usuario);
        if (telefono) {
            const chat = await client.getChatById(telefono);
            await chat.sendMessage(mensaje);
        }
        
        await sheets.spreadsheets.values.append({
            auth,
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Alertas!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[new Date().toISOString(), gasto.usuario, gasto.categoria, mensaje, 'NO']] }
        });
    }
}

// ============================================
// FUNCIÓN: Extraer datos del voucher con IA
// ============================================
async function extraerDatosVoucher(textoOCR) {
    const prompt = `
Extrae la información de este voucher peruano:
"${textoOCR}"

Responde SOLO con JSON:
{
    "monto": "número",
    "moneda": "PEN o USD",
    "comercio": "nombre del local",
    "fecha": "YYYY-MM-DD"
}`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
        const datos = JSON.parse(jsonMatch[0]);
        datos.monto = parseFloat(datos.monto);
        return datos;
    }
    return null;
}

function mostrarMenu(datos) {
    let menu = `📸 *Gasto detectado*\n`;
    menu += `💰 *Monto:* ${datos.moneda === 'PEN' ? 'S/' : 'US$'} ${datos.monto}\n`;
    menu += `🏪 *Comercio:* ${datos.comercio}\n\n`;
    menu += `*¿A qué categoría pertenece?*\n\n`;
    
    let opcion = 1;
    for (const [key, cat] of Object.entries(CATEGORIAS)) {
        const monedaCat = MONEDA_CATEGORIA[cat];
        if (monedaCat === datos.moneda || monedaCat === 'AMBAS') {
            menu += `${opcion}️⃣ ${cat}\n`;
            opcion++;
        }
    }
    menu += `\n_Responde con el número (1-${opcion-1})_`;
    
    return menu;
}

// ============================================
// FUNCIÓN: Analizar primer mes
// ============================================
async function analizarPrimerMes() {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const response = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: 'Gastos!A:F'
    });
    
    const rows = response.data.values || [];
    if (rows.length <= 1) {
        return "📊 No hay suficientes gastos registrados. Sigue registrando tus gastos por unos días más.";
    }
    
    const gastosPorCategoria = {};
    
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const categoria = row[5];
        const monto = parseFloat(row[3]);
        
        if (!gastosPorCategoria[categoria]) {
            gastosPorCategoria[categoria] = 0;
        }
        gastosPorCategoria[categoria] += monto;
    }
    
    let mensaje = "📊 *ANÁLISIS DEL PRIMER MES*\n\n";
    mensaje += "Basado en tus gastos reales, estos son los presupuestos sugeridos:\n\n";
    
    for (const [categoria, monto] of Object.entries(gastosPorCategoria)) {
        const sugerido = Math.ceil(monto * 1.1);
        const moneda = MONEDA_CATEGORIA[categoria] || 'PEN';
        mensaje += `${categoria}: ${moneda === 'USD' ? 'US$' : 'S/'} ${monto.toFixed(2)} → 💡 sugerido: ${moneda === 'USD' ? 'US$' : 'S/'} ${sugerido}\n`;
        
        PRESUPUESTOS[categoria] = {
            mensual: sugerido,
            moneda: moneda,
            gastado: 0,
            alerta80: false,
            alerta100: false
        };
    }
    
    mensaje += "\n✏️ *Para activar presupuestos y alertas escribe:* `ACTIVAR PRESUPUESTOS`\n";
    mensaje += "*Para ajustar manualmente:* `presupuesto [categoría] [monto]`\n";
    mensaje += "Ejemplo: `presupuesto Supermercado 800`";
    
    return mensaje;
}

// ============================================
// FUNCIÓN: Enviar reporte semanal
// ============================================
async function enviarReporteSemanal() {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const response = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: 'Gastos!A:F'
    });
    
    const rows = response.data.values || [];
    const hoy = new Date();
    const inicioSemana = new Date(hoy);
    inicioSemana.setDate(hoy.getDate() - hoy.getDay());
    
    let totalGastos = 0;
    let gastosPorCategoria = {};
    
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const fechaGasto = new Date(row[0]);
        if (fechaGasto >= inicioSemana) {
            const monto = parseFloat(row[3]);
            const categoria = row[5];
            totalGastos += monto;
            gastosPorCategoria[categoria] = (gastosPorCategoria[categoria] || 0) + monto;
        }
    }
    
    let reporte = "📊 *REPORTE SEMANAL*\n\n";
    reporte += `📅 Semana del ${inicioSemana.toLocaleDateString()}\n`;
    reporte += `💰 Total gastado: S/ ${totalGastos.toFixed(2)}\n\n`;
    reporte += "*Top gastos:*\n";
    
    const top = Object.entries(gastosPorCategoria)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    
    for (const [cat, monto] of top) {
        reporte += `${cat}: S/ ${monto.toFixed(2)}\n`;
    }
    
    for (const telefono of Object.keys(USUARIOS)) {
        try {
            const chat = await client.getChatById(telefono);
            await chat.sendMessage(reporte);
        } catch (e) {
            console.log(`No se pudo enviar a ${telefono}`);
        }
    }
}

// ============================================
// PROCESAR MENSAJES (VERSIÓN CORREGIDA PARA GRUPOS)
// ============================================
	async function procesarMensaje(message) {
    const telefono = message.from;
    const cuerpo = message.body || '';
    
    // 🔑 Detectar el remitente real dentro del grupo
    let remitente = telefono;
    
    if (message.from.includes('g.us')) {
        // Es un grupo: obtener quién envió el mensaje
        let authorId = message.author || message._data?.author;
        
        if (authorId) {
            // Extraer solo el número (ignorar @lid, @c.us, etc)
            const numeroMatch = authorId.match(/(\d+)/);
            if (numeroMatch) {
                const numeroLimpio = numeroMatch[1];
                remitente = numeroLimpio + '@c.us';
            } else {
                remitente = authorId.includes('@c.us') ? authorId : authorId + '@c.us';
            }
        }
    }
    
    // Limpiar cualquier formato extraño (@lid, etc)
    const numeroRealMatch = remitente.match(/(\d{10,15})/);
    if (numeroRealMatch) {
        remitente = numeroRealMatch[1] + '@c.us';
    }
    
    // Verificar autorización
    if (!USUARIOS[remitente]) {
        console.log(`⛔ Número NO autorizado: ${remitente}`);
        console.log(`📋 Esperaba: ${Object.keys(USUARIOS).join(', ')}`);
        return;
    }
    
    const usuario = USUARIOS[remitente];
    console.log(`✅ ${usuario.nombre} (${remitente}) dijo: "${cuerpo.substring(0, 50)}"`);
    
    // ========== COMANDOS ==========
    if (cuerpo.toUpperCase() === 'ACTIVAR PRESUPUESTOS') {
        MODO_REGISTRO_LIBRE = false;
        await message.reply("✅ *Presupuestos activados!*\n\nAhora recibirás alertas cuando alcances el 80% y 100% de cada categoría.\n\nUsa `estado` para ver tu progreso.");
        return;
    }
    
    if (cuerpo.toLowerCase() === 'estado') {
        if (MODO_REGISTRO_LIBRE) {
            await message.reply("📝 *Modo Registro Libre*\n\nEstás en tu primer mes. Sigue registrando gastos. Después usa `analizar` para obtener presupuestos sugeridos.");
        } else {
            let estado = "📊 *ESTADO DE PRESUPUESTOS*\n\n";
            for (const [cat, data] of Object.entries(PRESUPUESTOS)) {
                if (data.mensual > 0) {
                    const porcentaje = (data.gastado / data.mensual * 100).toFixed(1);
                    const barra = '█'.repeat(Math.floor(porcentaje / 5)) + '░'.repeat(20 - Math.floor(porcentaje / 5));
                    estado += `${cat}\n`;
                    estado += `${barra} ${porcentaje}%\n`;
                    estado += `${data.moneda === 'USD' ? 'US$' : 'S/'} ${data.gastado.toFixed(2)} / ${data.mensual}\n\n`;
                }
            }
            await message.reply(estado);
        }
        return;
    }
    
    if (cuerpo.toLowerCase() === 'analizar') {
        const resultado = await analizarPrimerMes();
        await message.reply(resultado);
        return;
    }
    
    if (cuerpo.toLowerCase() === 'reporte') {
        await enviarReporteSemanal();
        await message.reply("📊 Reporte semanal enviado");
        return;
    }
    
    const presupuestoMatch = cuerpo.toLowerCase().match(/^presupuesto\s+(.+?)\s+(\d+(?:\.\d+)?)/);
    if (presupuestoMatch && !MODO_REGISTRO_LIBRE) {
        const categoriaNombre = presupuestoMatch[1].trim();
        const monto = parseFloat(presupuestoMatch[2]);
        
        let categoriaEncontrada = null;
        for (const cat of Object.keys(PRESUPUESTOS)) {
            if (cat.toLowerCase().includes(categoriaNombre.toLowerCase())) {
                categoriaEncontrada = cat;
                break;
            }
        }
        
        if (categoriaEncontrada) {
            PRESUPUESTOS[categoriaEncontrada].mensual = monto;
            PRESUPUESTOS[categoriaEncontrada].gastado = 0;
            PRESUPUESTOS[categoriaEncontrada].alerta80 = false;
            PRESUPUESTOS[categoriaEncontrada].alerta100 = false;
            await message.reply(`✅ Presupuesto actualizado:\n${categoriaEncontrada}: ${PRESUPUESTOS[categoriaEncontrada].moneda === 'USD' ? 'US$' : 'S/'} ${monto}`);
        } else {
            await message.reply(`❌ Categoría no encontrada. Categorías: ${Object.keys(PRESUPUESTOS).join(', ')}`);
        }
        return;
    }
    
    // ========== ESPERANDO CATEGORÍA ==========
    if (esperandoCategoria.has(remitente)) {
        const datosPendientes = esperandoCategoria.get(remitente);
        const opcion = parseInt(cuerpo);
        
        const categoriasDisponibles = [];
        for (const [key, cat] of Object.entries(CATEGORIAS)) {
            const monedaCat = MONEDA_CATEGORIA[cat];
            if (monedaCat === datosPendientes.moneda || monedaCat === 'AMBAS') {
                categoriasDisponibles.push(cat);
            }
        }
        
        if (opcion >= 1 && opcion <= categoriasDisponibles.length) {
            const categoriaSeleccionada = categoriasDisponibles[opcion - 1];
            
            const gasto = {
                fecha: datosPendientes.fecha || new Date().toISOString().split('T')[0],
                usuario: usuario.nombre,
                comercio: datosPendientes.comercio,
                monto: datosPendientes.monto,
                moneda: datosPendientes.moneda,
                categoria: categoriaSeleccionada
            };
            
            await guardarGasto(gasto);
            esperandoCategoria.delete(remitente);
            await message.reply(`✅ *¡Gasto registrado!*\n📂 ${categoriaSeleccionada}\n💰 ${gasto.moneda === 'PEN' ? 'S/' : 'US$'} ${gasto.monto}\n👤 ${usuario.nombre}`);
        } else {
            await message.reply(`❌ Opción inválida. Elige 1-${categoriasDisponibles.length}`);
        }
        return;
    }
    
    // ========== PROCESAR IMAGEN (VOUCHER) ==========
    if (message.hasMedia) {
        try {
            await message.reply(`📸 *Procesando voucher...*\n👤 ${usuario.nombre}`);
            
            const media = await message.downloadMedia();
            const imageBuffer = Buffer.from(media.data, 'base64');
            const { data: { text } } = await Tesseract.recognize(imageBuffer, 'spa');
            
            if (!text || text.trim().length < 10) {
                await message.reply('❌ No pude leer el voucher. Envía una foto más clara.');
                return;
            }
            
            const datos = await extraerDatosVoucher(text);
            
            if (!datos || !datos.monto) {
                await message.reply('❌ No pude extraer el monto. Escribe el gasto manualmente.');
                return;
            }
            
            esperandoCategoria.set(remitente, datos);
            const menu = mostrarMenu(datos);
            await message.reply(menu);
            
        } catch (error) {
            console.error(error);
            await message.reply('❌ Error al procesar la imagen. Intenta de nuevo.');
        }
        return;
    }
    
    // ========== MENSAJE DE AYUDA ==========
    await message.reply(
        "🤖 *Bot de Finanzas*\n\n" +
        "*Comandos:*\n" +
        "📸 *Envía una foto* → Registra un gasto\n" +
        "📊 `reporte` → Resumen semanal\n" +
        "📈 `analizar` → Analiza tu primer mes\n" +
        "💰 `estado` → Ver progreso de presupuestos\n" +
        "✏️ `presupuesto [cat] [monto]` → Ajustar presupuesto\n\n" +
        (MODO_REGISTRO_LIBRE ? 
            "🔓 *Modo: Registro Libre* (primer mes de prueba)\n" +
            "💡 Después de 30 días usa `analizar`" : 
            "🔒 *Modo: Presupuestos Activos*\n" +
            "🔔 Recibirás alertas al 80% y 100%")
    );
}

// ============================================
// INICIAR BOT
// ============================================
let client;

async function iniciarBot() {
    console.log('🚀 Iniciando bot...');
    await inicializarSheets();
    console.log('✅ Sheets inicializado');
    console.log('🚀 Creando cliente de WhatsApp...');
    
   client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './session-data'
    }),
    puppeteer: { 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ],
        timeout: 120000  // 2 minutos de espera
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1030406899.html',
    },
    authTimeoutMs: 120000  // 2 minutos para autenticación
});


    client.on('qr', (qr) => {
    console.log('📱 ESCANEA ESTE QR CON WHATSAPP:');
    console.log('🔗 O abre este enlace en tu navegador para ver el QR:');
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
});

    client.on('qr', (qr) => {
    // Extraer solo números del QR
    const soloNumeros = qr.replace(/\D/g, '');
    const codigo8 = soloNumeros.slice(-8);
    console.log('📱 CÓDIGO DE 8 DÍGITOS:', codigo8);
    console.log('📱 QR TAMBIÉN DISPONIBLE ARRIBA');
});

client.on('qr', (qr) => {
        console.log('📱 ESCANEA ESTE QR CON WHATSAPP:');
        qrcode.generate(qr, { small: true });
    });
    
    client.on('ready', () => {
        console.log('✅ Bot conectado a WhatsApp!');
    });
    
    client.on('message', async (message) => {
        if (message.from === 'status@broadcast') return;
        await procesarMensaje(message);
    });
    
    await client.initialize();
}

iniciarBot();