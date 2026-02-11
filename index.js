import 'dotenv/config'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import TelegramBot from 'node-telegram-bot-api'
import fs from 'fs'
import path from 'path'

// --- CONFIGURATION MANAGEMENT ---
const DB_PATH = './database.json'
let config = {
    targets: [], // Changed from single target to array
    message: 'Selamat ',
    interval: 5000,
    isRunning: false,
    imagePath: null
}

// Ensure media directory exists
const MEDIA_DIR = './media'
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR)
}

// Load config from disk
try {
    if (fs.existsSync(DB_PATH)) {
        const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
        // Migration support: if old config has 'target' string, move to 'targets' array
        if (loaded.target && !loaded.targets) {
            loaded.targets = [loaded.target]
            delete loaded.target
        }
        config = { ...config, ...loaded }
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
    console.log('Telegram Polling Error:', error.code, error.message);
});

telegramBot.on('message', (msg) => {
    const chatId = msg.chat.id
    console.log(`📩 Received message from ${chatId}:`, msg.text || msg.caption || '[Media]')

    // First person to message becomes owner (temporary logic for convenience)
    if (!OWNER_ID) {
        OWNER_ID = chatId
        console.log(`👑 Owner registered: ${OWNER_ID}`)
        telegramBot.sendMessage(chatId, `👑 Kamu sekarang adalah Owner bot ini.\nID kamu: ${chatId}`)
    }

    // Security Check
    if (chatId !== OWNER_ID) {
        console.log(`⛔ Ignored message from non-owner: ${chatId}`)
        return
    }
})

// COMMANDS
telegramBot.onText(/\/start/, (msg) => {
    console.log('➡️ Command: /start')
    if (msg.chat.id !== OWNER_ID) return;
    if (!config.targets || config.targets.length === 0) {
        return telegramBot.sendMessage(msg.chat.id, '⚠️ Belum ada target! Gunakan `/addtarget [nomor]` dulu.')
    }

    config.isRunning = true
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, `🚀 Bot WhatsApp **DIMULAI**.\nMengirim ke ${config.targets.length} target.`, { parse_mode: 'Markdown' })
    console.log('Bot STARTED via Telegram')
})

telegramBot.onText(/\/stop/, (msg) => {
    console.log('➡️ Command: /stop')
    if (msg.chat.id !== OWNER_ID) return;
    config.isRunning = false
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, '🛑 Bot WhatsApp **DIBERHENTIKAN**.', { parse_mode: 'Markdown' })
    console.log('Bot STOPPED via Telegram')
})

telegramBot.onText(/\/status/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    const status = `
📊 **STATUS BOT (Broadcast Mode)**
    
🟢 **Status**: ${config.isRunning ? 'RUNNING 🚀' : 'STOPPED 🛑'}
🎯 **Total Target**: ${config.targets.length}
⏱ **Interval**: ${config.interval} ms
💬 **Pesan**: "${config.message}"
🖼 **Gambar**: ${config.imagePath ? '✅ Ada' : '❌ Tidak ada'}

Ketik /listtarget untuk lihat detail.
    `
    telegramBot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' })
})

// --- MEDIA MANAGEMENT ---

// SET IMAGE (Upload via Telegram)
telegramBot.on('photo', async (msg) => {
    console.log('📸 Photo event received')
    if (msg.chat.id !== OWNER_ID) return;

    // Check if caption contains /setimage (or just assume any photo is for setting image if we want)
    if (msg.caption && msg.caption.includes('/setimage')) {
        console.log('📸 Processing /setimage from caption...')
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id // Get highest res
            console.log('⬇️ Downloading file:', fileId)
            const filePath = await telegramBot.downloadFile(fileId, MEDIA_DIR)

            config.imagePath = filePath
            saveConfig()

            console.log('✅ Image saved to:', filePath)
            telegramBot.sendMessage(msg.chat.id, `✅ Gambar berhasil diset!\nPath: \`${filePath}\``, { parse_mode: 'Markdown' })
        } catch (e) {
            console.error('Download failed:', e)
            telegramBot.sendMessage(msg.chat.id, `❌ Gagal download gambar: ${e.message}`)
        }
    } else {
        console.log('📸 Photo received but no /setimage caption')
    }
})

// Allow setting image by replying to a photo
telegramBot.onText(/\/setimage/, async (msg) => {
    console.log('➡️ Command: /setimage (Text/Reply)')
    if (msg.chat.id !== OWNER_ID) return;

    if (msg.reply_to_message && msg.reply_to_message.photo) {
        console.log('📸 Processing /setimage from Reply...')
        try {
            const fileId = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1].file_id
            const filePath = await telegramBot.downloadFile(fileId, MEDIA_DIR)

            config.imagePath = filePath
            saveConfig()

            telegramBot.sendMessage(msg.chat.id, `✅ Gambar berhasil diset (dari reply)!\nPath: \`${filePath}\``, { parse_mode: 'Markdown' })
        } catch (e) {
            console.error('Reply Download failed:', e)
            telegramBot.sendMessage(msg.chat.id, `❌ Gagal download gambar: ${e.message}`)
        }
    } else if (!msg.caption) {
        // If just text command without photo/reply
        console.log('⚠️ /setimage called without photo')
        telegramBot.sendMessage(msg.chat.id, 'kirim Foto dengan caption `/setimage` atau Reply sebuah foto dengan `/setimage`.', { parse_mode: 'Markdown' })
    }
})


// CLEAR IMAGE
telegramBot.onText(/\/clearimage/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;

    if (config.imagePath && fs.existsSync(config.imagePath)) {
        try {
            fs.unlinkSync(config.imagePath)
        } catch (e) {
            console.error('Delete failed:', e)
        }
    }

    config.imagePath = null
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, '🗑 Gambar dihapus. Kembali ke mode teks.')
})

// --- BROADCAST TARGET MANAGEMENT ---

// ADD TARGET
telegramBot.onText(/\/addtarget (.+)/, (msg, match) => {
    if (msg.chat.id !== OWNER_ID) return;
    let input = match[1].trim()

    // Auto-format format JID
    if (!input.includes('@')) {
        input = input.replace(/\D/g, '') + '@s.whatsapp.net' // Remove non-digits then add suffix
    }

    // Prevent duplicates
    if (!config.targets.includes(input)) {
        config.targets.push(input)
        saveConfig()
        telegramBot.sendMessage(msg.chat.id, `✅ Target ditambah: \`${input}\`\nTotal: ${config.targets.length}`, { parse_mode: 'Markdown' })
    } else {
        telegramBot.sendMessage(msg.chat.id, `⚠️ Target \`${input}\` sudah ada di list!`, { parse_mode: 'Markdown' })
    }
})

// DELETE TARGET
telegramBot.onText(/\/deltarget (.+)/, (msg, match) => {
    if (msg.chat.id !== OWNER_ID) return;
    let input = match[1].trim()

    // Attempt multiple formats to find the target to delete
    // 1. Exact match
    // 2. With suffix added
    let targetToDelete = input
    if (!config.targets.includes(targetToDelete)) {
        targetToDelete = input.replace(/\D/g, '') + '@s.whatsapp.net'
    }

    if (config.targets.includes(targetToDelete)) {
        config.targets = config.targets.filter(t => t !== targetToDelete)
        saveConfig()
        telegramBot.sendMessage(msg.chat.id, `🗑 Target dihapus: \`${targetToDelete}\`\nSisa: ${config.targets.length}`, { parse_mode: 'Markdown' })
    } else {
        telegramBot.sendMessage(msg.chat.id, `⚠️ Target tidak ditemukan. Cek /listtarget.`)
    }
})

// LIST TARGETS
telegramBot.onText(/\/listtarget/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    if (config.targets.length === 0) return telegramBot.sendMessage(msg.chat.id, '📭 List target kosong.')

    let list = '📋 **DAFTAR TARGET**:\n'
    config.targets.forEach((t, i) => {
        list += `${i + 1}. \`${t}\`\n`
    })
    telegramBot.sendMessage(msg.chat.id, list, { parse_mode: 'Markdown' })
})

// CLEAR ALL
telegramBot.onText(/\/cleartargets/, (msg) => {
    if (msg.chat.id !== OWNER_ID) return;
    config.targets = []
    saveConfig()
    telegramBot.sendMessage(msg.chat.id, '🗑 Semua target dihapus.')
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
🛠 **DAFTAR PERINTAH (BROADCAST)**

/status - Cek status bot
/start - Mulai broadcast
/stop - Stop broadcast
/addtarget [nomor] - Tambah target
/deltarget [nomor] - Hapus target
/listtarget - Lihat daftar target
/cleartargets - Hapus semua target
/setmsg [pesan] - Set isi pesan ("Selamat " = auto waktu)
/setinterval [ms] - Set jeda waktu
/setimage - Kirim foto dengan caption ini atau reply foto dengan perintah ini untuk set gambar
/clearimage - Hapus gambar yang diset
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
async function startMessageLoop(sock) {
    const loop = async () => {
        if (config.isRunning && config.targets && config.targets.length > 0) {
            console.log(`⚡ Sending broadcast to ${config.targets.length} targets...`)

            // Loop through all targets
            for (const targetJid of config.targets) {
                try {
                    // Dynamic Message Construction
                    let finalMessage = config.message

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

                    // Check if Image is set
                    if (config.imagePath && fs.existsSync(config.imagePath)) {
                        const imageBuffer = fs.readFileSync(config.imagePath)
                        await sock.sendMessage(targetJid, {
                            image: imageBuffer,
                            caption: finalMessage
                        })
                        console.log(`📸 Sent IMAGE to ${targetJid}`)
                    } else {
                        // Text only
                        await sock.sendMessage(targetJid, { text: finalMessage })
                        console.log(`📨 Sent TEXT to ${targetJid}: ${finalMessage}`)
                    }

                    // Small delay between sends to prevent instant ban / rate limit
                    await new Promise(r => setTimeout(r, 1000))

                } catch (err) {
                    console.error(`❌ Send failed to ${targetJid}:`, err.message)
                }
            }
        } else {
            // Idle logic
        }

        // Schedule next run
        setTimeout(loop, config.interval)
    }

    loop() // Start the loop
}

// Start
console.log('🚀 Starting System...')
connectToWhatsApp().catch(err => console.log('unexpected error: ' + err))
