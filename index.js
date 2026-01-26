import 'dotenv/config'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import TelegramBot from 'node-telegram-bot-api'
import fs from 'fs'

// --- CONFIGURATION MANAGEMENT ---
const DB_PATH = './database.json'
let config = {
    target: '',
    message: 'Selamat ',
    interval: 5000,
    isRunning: false
}

// Load config from disk
try {
    if (fs.existsSync(DB_PATH)) {
        config = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
        console.log('✅ Config loaded:', config)
    }
} catch (e) {
    console.error('❌ Failed to load config:', e)
}

// Save config to disk
function saveConfig() {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(config, null, 2))
    } catch (e) {
        console.error('❌ Failed to save config:', e)
    }
}

// --- TELEGRAM BOT SETUP ---
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is missing in .env')
    process.exit(1)
}

const telegramBot = new TelegramBot(token, { polling: true })

// Helper to check/save owner (simple security)
let OWNER_ID = null

// Simple logging for Telegram errors
telegramBot.on('polling_error', (error) => {
    console.log('Telegram Polling Error:', error.code);  // E.g. ETELEGRAM
});

telegramBot.on('message', (msg) => {
    const chatId = msg.chat.id

    // First person to message becomes owner (temporary logic for convenience)
    if (!OWNER_ID) {
        OWNER_ID = chatId
        console.log(`👑 Owner registered: ${OWNER_ID}`)
        telegramBot.sendMessage(chatId, `👑 Kamu sekarang adalah Owner bot ini.\nID kamu: ${chatId}`)
    }

    // Security Check
    if (chatId !== OWNER_ID) {
        // telegramBot.sendMessage(chatId, '⛔ Maaf, kamu tidak punya akses ke bot ini.')
        return
    }
})

// COMMANDS
telegramBot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    if (!config.target) return telegramBot.sendMessage(msg.chat.id, '⚠️ Target belum diset! Gunakan `/settarget [nomor]` dulu.')

    config.isRunning = true
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, `🚀 Bot WhatsApp **DIMULAI**.\nMengirim ke: \`${config.target}\``, { parse_mode: 'Markdown' })
    console.log('Bot STARTED via Telegram')
})

telegramBot.onText(/\/stop/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    config.isRunning = false
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, '🛑 Bot WhatsApp **DIBERHENTIKAN**.', { parse_mode: 'Markdown' })
    console.log('Bot STOPPED via Telegram')
})

telegramBot.onText(/\/status/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    const status = `
📊 **STATUS BOT**
    
🟢 **Status**: ${config.isRunning ? 'RUNNING 🚀' : 'STOPPED 🛑'}
🎯 **Target**: \`${config.target || 'Belum diset'}\`
⏱ **Interval**: ${config.interval} ms
💬 **Pesan**: "${config.message}"
    `
    telegramBot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' })
})

telegramBot.onText(/\/settarget (.+)/, (msg, match) => {
    if (msg.chat.id !== OWNER_ID) return;
    config.target = match[1].trim() // Can be number or Group ID
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, `🎯 Target diubah ke: \`${config.target}\``, { parse_mode: 'Markdown' })
})

telegramBot.onText(/\/setmsg (.+)/, (msg, match) => {
    if (msg.chat.id !== OWNER_ID) return;
    config.message = match[1]
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, `💬 Pesan diubah: "${config.message}"`)
})

telegramBot.onText(/\/setinterval (\d+)/, (msg, match) => {
    if (msg.chat.id !== OWNER_ID) return;
    const newInterval = parseInt(match[1])
    if (newInterval < 1000) return telegramBot.sendMessage(msg.chat.id, '⚠️ Interval minimal 1000ms (1 detik) agar aman.')

    config.interval = newInterval
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, `⏱ Interval diubah ke: ${config.interval} ms`)
})

telegramBot.onText(/\/help/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    const help = `
🛠 **DAFTAR PERINTAH**

/status - Cek status bot
/start - Mulai kirim pesan
/stop - Stop kirim pesan
/settarget [nomor] - Set target (contoh: 62812345678)
/setmsg [pesan] - Set isi pesan ("Selamat " = auto waktu)
/setinterval [ms] - Set jeda waktu (contoh: 5000)
    `
    telegramBot.sendMessage(msg.chat.id, help)
})


// --- WHATSAPP BOT SETUP ---

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('Scan the QR code below to login:')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected!')
            startMessageLoop(sock)
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

// --- MESSAGING LOOP ---
// Using recursive setTimeout to handle dynamic interval changes nicely
async function startMessageLoop(sock) {
    const loop = async () => {
        if (config.isRunning && config.target) {
            try {
                // Dynamic Message Construction
                let finalMessage = config.message

                // If message starts with "Selamat ", append dynamic time
                if (finalMessage.startsWith('Selamat ')) {
                    const now = new Date()
                    const hours = now.getHours()
                    let greetingSuffix = ''
                    if (hours >= 3 && hours < 11) greetingSuffix = 'Pagi'
                    else if (hours >= 11 && hours < 15) greetingSuffix = 'Siang'
                    else if (hours >= 15 && hours < 18) greetingSuffix = 'Sore'
                    else greetingSuffix = 'Malam'

                    if (config.message.trim() === 'Selamat' || config.message.trim() === 'Selamat ') {
                        finalMessage = `Selamat ${greetingSuffix}! sekarang pukul ${now.toLocaleTimeString('id-ID', { hour12: false })} WIB`
                    } else {
                        finalMessage = config.message
                            .replace('{time}', now.toLocaleTimeString('id-ID', { hour12: false }))
                            .replace('{greet}', `Selamat ${greetingSuffix}`)
                    }
                }

                // Ensure target JID is properly formatted
                let targetJid = config.target
                if (!targetJid.includes('@')) {
                    targetJid = targetJid + '@s.whatsapp.net'
                }

                await sock.sendMessage(targetJid, { text: finalMessage })
                console.log(`📨 Sent to ${targetJid}: ${finalMessage}`)
            } catch (err) {
                console.error('❌ Send failed:', err.message)
            }
        } else {
            // Idle logic, no op
        }

        // Schedule next run based on CURRENT config.interval
        setTimeout(loop, config.interval)
    }

    loop() // Start the loop
}

// Start
console.log('🚀 Starting System...')
connectToWhatsApp().catch(err => console.log('unexpected error: ' + err))
