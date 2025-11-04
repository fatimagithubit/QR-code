// Node.js WhatsApp Gateway (Render Par Chale)

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
// Render environment variable use karein
const port = process.env.PORT || 3000; 
const server = http.createServer(app);
const io = new socketIo.Server(server);

// JSON body parser enable karein
app.use(express.json());

// CORS (Cross-Origin Resource Sharing) enable karein
// Taki PythonAnywhere se request accept ho sake
app.use((req, res, next) => {
    // Ye line aapke Django app ko is API tak pahunchne ki anumati degi
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// User sessions store karne ke liye Map
const clients = new Map();

// --- Health Check Endpoint (Browser error fix) ---
app.get('/', (req, res) => {
    res.status(200).send({
        status: 'OK',
        message: 'WhatsApp Gateway API is running successfully. Use /start endpoint for connecting.'
    });
});
// ----------------------------------------------------

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
                '--single-process', 
                '--disable-gpu'
            ],
        },
    });

    clients.set(userId, client);
    return client;
}

// ----------------------------------------------------
// API ENDPOINT FOR DJANGO COMMUNICATION
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
    // Is flag ko istemaal karein yeh track karne ke liye ki response bheja gaya hai ya nahi
    let response_sent = false; 

    // --- QR CODE EVENT LISTENER ---
    const onQr = async (qr) => {
        if (response_sent) return;

        try {
            const qrDataURL = await qrcode.toDataURL(qr);
            response_sent = true; 
            
            // Django ko response bhejein
            res.json({
                status: 'QR_AVAILABLE',
                qr_code_base64: qrDataURL,
                message: 'QR Code Scan Karein.'
            });
            
            // Listener ko hata dein
            client.off('qr', onQr); 

        } catch (error) {
            console.error(`Error generating QR code for ${userId}:`, error);
            if (!response_sent) {
                res.status(500).json({ status: 'ERROR', message: 'Failed to generate QR code image.' });
                response_sent = true;
            }
            client.off('qr', onQr);
        }
    };

    // Agar client pehle se connected hai, toh turant status bhej dein
    if (client.info) {
        return res.json({ status: 'CONNECTED', message: 'Client is already connected.' });
    }
    
    // --- READY EVENT LISTENER ---
    const onReady = () => {
        console.log(`Client READY for user: ${userId}`);
        if (!response_sent) {
             res.json({ status: 'CONNECTED', message: 'Client connected successfully (session loaded).' });
             response_sent = true;
        }
        client.off('qr', onQr); 
        client.off('ready', onReady); // Listener ko hata dein
    };
    
    // --- AUTH FAILED LISTENER ---
    const onAuthFailure = (msg) => {
        console.error('AUTHENTICATION FAILURE', msg);
        if (!response_sent) {
            res.status(401).json({ status: 'AUTH_FAILED', message: 'Authentication failed. Please try re-scanning the QR.' });
            response_sent = true;
        }
        client.off('qr', onQr);
        client.off('ready', onReady);
        client.off('auth_failure', onAuthFailure); // Listener ko hata dein
    };

    client.on('qr', onQr);
    client.on('ready', onReady);
    client.on('auth_failure', onAuthFailure);
    
    // --- DISCONNECTED LISTENER ---
    client.on('disconnected', (reason) => {
        console.log('Client was disconnected:', reason);
        clients.delete(userId);
    });

    // Client initialization shuru karein
    try {
        await client.initialize();
    } catch (e) {
        console.error(`Initialization failed for ${userId}:`, e);
        if (!response_sent) {
            res.status(500).json({ status: 'ERROR', message: 'Client initialization failed.' });
        }
    }
});


// ----------------------------------------------------
// SEND MESSAGE ENDPOINT (Aage ke step ke liye)
// ----------------------------------------------------
app.post('/send', async (req, res) => {
    // ... Yeh endpoint aage ke steps mein messages bhejane ke liye istemaal hoga ...
    res.status(501).json({ success: false, message: "Send logic yet to be fully implemented." });
});


server.listen(port, () => {
    console.log(`WhatsApp Multi-User Service running on port ${port}`);
});
