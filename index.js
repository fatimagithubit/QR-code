// Node.js WhatsApp Gateway (Render Par Chale)

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new socketIo.Server(server);

app.use(express.json());

// CORS (Cross-Origin Resource Sharing) enable karein
// Production mein, isko apne PythonAnywhere URL se badal dein
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// User sessions store karne ke liye Map
const clients = new Map();

/**
 * Naya WhatsApp client instance banata hai ya existing leta hai.
 * @param {string} userId - Session identify karne ke liye user ID.
 * @returns {Client} - WhatsApp Client instance.
 */
function createClientInstance(userId) {
    if (clients.has(userId)) {
        return clients.get(userId);
    }
    
    // LocalAuth session files ko /whatsapp_session_{userId} folder mein save karega
    const sessionPath = `whatsapp_session_${userId}`;
    console.log(`Creating new client for userId: ${userId} with dataPath: ${sessionPath}`);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
            headless: true, // Render ke liye zaroori
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Rander par single-process use karein
                '--disable-gpu'
            ],
        },
    });

    clients.set(userId, client);
    return client;
}

// ----------------------------------------------------
// API ENDPOINTS FOR DJANGO COMMUNICATION
// ----------------------------------------------------

/**
 * QR Code generate karne aur session shuru karne ke liye endpoint
 * Django se isko call kiya jaega.
 */
app.post('/start', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ status: 'ERROR', message: 'UserId is required.' });
    }

    const client = createClientInstance(userId);
    let qr_sent = false;

    // --- QR CODE EVENT LISTENER ---
    // Jab QR code available hoga, use Base64 data URL mein convert karke
    // Django ko HTTP Response mein bhej denge.
    const onQr = async (qr) => {
        if (qr_sent) return;

        try {
            const qrDataURL = await qrcode.toDataURL(qr);
            qr_sent = true; 
            
            // Django ko response bhejein
            res.json({
                status: 'QR_AVAILABLE',
                qr_code_base64: qrDataURL,
                message: 'Scan the QR code to connect.'
            });
            
            // Listener ko hata dein taki yeh dobara trigger na ho jab client CONNECTED ho jae
            client.off('qr', onQr); 

        } catch (error) {
            console.error(`Error generating QR code for ${userId}:`, error);
            if (!qr_sent) {
                res.status(500).json({ status: 'ERROR', message: 'Failed to generate QR code image.' });
                qr_sent = true;
            }
            client.off('qr', onQr);
        }
    };

    // Agar client pehle se connected hai ya session load ho raha hai
    if (client.info) {
        return res.json({ status: 'CONNECTED', message: 'Client is already connected.' });
    }

    client.on('qr', onQr);
    
    // --- READY EVENT LISTENER ---
    client.on('ready', () => {
        console.log(`Client READY for user: ${userId}`);
        // Agar client READY ho gaya hai aur QR code abhi tak nahi bheja gaya tha (matlab session saved tha)
        if (!qr_sent) {
             res.json({ status: 'CONNECTED', message: 'Client connected successfully (session loaded).' });
             qr_sent = true;
        }
        client.off('qr', onQr); // Ready hone ke baad QR listener hatana
    });
    
    // --- AUTH FAILED LISTENER ---
    client.on('auth_failure', (msg) => {
        console.error('AUTHENTICATION FAILURE', msg);
        if (!qr_sent) {
            res.status(401).json({ status: 'AUTH_FAILED', message: 'Authentication failed. Please try re-scanning the QR.' });
            qr_sent = true;
        }
        client.off('qr', onQr);
    });

    // --- DISCONNECTED LISTENER ---
    client.on('disconnected', (reason) => {
        console.log('Client was disconnected:', reason);
        // Clean up client from map if it disconnects completely
        clients.delete(userId);
    });

    // Client initialization shuru karein
    try {
        await client.initialize();
    } catch (e) {
        console.error(`Initialization failed for ${userId}:`, e);
        if (!qr_sent) {
            res.status(500).json({ status: 'ERROR', message: 'Client initialization failed.' });
        }
    }
});

/**
 * Session status check karne ke liye endpoint (Django ke task file mein use hoga)
 */
app.get('/status', (req, res) => {
    const userId = req.query.userId;
    const client = clients.get(userId);

    if (!client) {
        return res.json({ status: 'NOT_INITIALIZED', message: 'Client not initialized or disconnected.' });
    }

    // `info` object ka existence hi connection ka saboot hai (WhatsApp-web.js mein)
    if (client.info) {
        return res.json({ status: 'CONNECTED', message: `Client is connected as ${client.info.pushname}.` });
    }

    return res.json({ status: 'INITIALIZING', message: 'Client is initializing or waiting for QR scan.' });
});

// Aapka /send endpoint (pichle response se)
app.post('/send', async (req, res) => {
    // ... pichle response ka /send logic yahan aega ...
    res.status(501).json({ success: false, message: "Send logic yet to be fully implemented." });
});

server.listen(port, () => {
    console.log(`WhatsApp Multi-User Service running on port ${port}`);
});
