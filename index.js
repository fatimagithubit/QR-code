// Node.js WhatsApp Gateway (Polling Architecture)

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http'); 
// Socket.io removed to ensure clean deployment on Render

const app = express();
const port = process.env.PORT || 3000; 
const server = http.createServer(app);

app.use(express.json());

// CORS enable karein (Allow all origins for simplicity)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// User sessions store karne ke liye Map
const clients = new Map();

// --- Health Check Endpoint ---
app.get('/', (req, res) => {
    res.status(200).send({
        status: 'OK',
        message: 'WhatsApp Gateway API is running successfully. Check /status, /start, /disconnect endpoints.'
    });
});
// ----------------------------------------------------

/**
 * Creates a new WhatsApp client instance or returns an existing one.
 * @param {string} userId - Session identifier.
 * @returns {Client} - WhatsApp Client instance.
 */
function createClientInstance(userId) {
    if (clients.has(userId)) {
        return clients.get(userId);
    }
    
    const sessionPath = `whatsapp_session_${userId}`;
    console.log(`Creating new client for userId: ${userId} with dataPath: ${sessionPath}`);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
            headless: true, 
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
    
    // Add QR code storage property
    client.qr_code = null; 

    // Session disconnect hone par client ko map se hata dein
    client.on('disconnected', async (reason) => {
        console.log(`Client ${userId} was disconnected:`, reason);
        // Ensure to remove the client from the map
        clients.delete(userId); 
        // We can also try to destroy it one last time if it's still listed in the map
        try {
           await client.destroy();
        } catch(e) { /* ignore */ }
    });
    
    // QR Code Event Listener: Store QR data for the /status endpoint
    client.on('qr', async (qr) => {
        try {
            const qrDataURL = await qrcode.toDataURL(qr);
            client.qr_code = qrDataURL.split(',')[1]; // Store only the Base64 data
            console.log(`QR code available for user: ${userId}`);
        } catch (error) {
            console.error(`Error generating QR code for ${userId}:`, error);
        }
    });

    // Ready Event Listener: Clear QR code once connected
    client.on('ready', () => {
        console.log(`Client READY for user: ${userId}`);
        client.qr_code = null; 
    });
    
    // Auth Failure Listener: Set a flag to inform the user via /status
    client.on('auth_failure', (msg) => {
        console.error('AUTHENTICATION FAILURE', msg);
        client.qr_code = 'AUTH_FAILED'; 
        // Do not destroy yet, let /status handle the destruction/re-initialization
    });


    clients.set(userId, client);
    return client;
}

// ----------------------------------------------------
// API ENDPOINT 1: /start (Initializes Client in Background)
// ----------------------------------------------------
app.post('/start', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ status: 'ERROR', message: 'UserId is required.' });
    }

    // Check if a client exists and is already connected
    const existingClient = clients.get(userId);
    if (existingClient && existingClient.info) {
         return res.json({ status: 'CONNECTED', message: 'Client is already connected.' });
    }

    const client = createClientInstance(userId);

    // If client is already initializing, just inform Django to start polling
    if (client.state === 'INITIALIZING') {
        return res.json({ status: 'STARTING', message: 'Client already initializing. Start polling for status.' });
    }

    // Client initialization starts here (non-blocking)
    client.initialize()
        .then(() => console.log(`Initialization for ${userId} successfully finished setup.`))
        .catch(e => console.error(`Initialization failed during client.initialize() for ${userId}:`, e));

    // Immediately return a STARTING status to prevent Django timeout
    return res.json({ status: 'STARTING', message: 'Client initialization started in background. Please poll /status.' });
});


// ----------------------------------------------------
// API ENDPOINT 2: /status (Polling)
// ----------------------------------------------------
app.get('/status', async (req, res) => {
    const userId = req.query.userId || req.body.userId; // Allow both GET query and POST body for flexibility

    if (!userId) {
        return res.status(400).json({ status: 'ERROR', message: 'UserId is required.' });
    }

    const client = clients.get(userId);

    if (!client) {
        return res.json({ status: 'DISCONNECTED', message: 'No active session found.' });
    }
    
    // State 1: Client is fully connected
    if (client.info) {
        // Clear QR code just in case
        client.qr_code = null;
        return res.json({ 
            status: 'CONNECTED', 
            message: 'Client connected successfully.',
            connection_info: {
                id: client.info.me.user,
                name: client.info.pushname || 'WhatsApp User',
            }
        });
    }

    // State 2: QR code is ready to be scanned
    if (client.qr_code && client.qr_code !== 'AUTH_FAILED') {
        return res.json({ 
            status: 'QR_READY', 
            message: 'Scan the QR Code to connect.',
            qr: client.qr_code // Base64 data
        });
    }

    // State 3: Authentication failed (needs a fresh start)
    if (client.qr_code === 'AUTH_FAILED') {
        // Clean up the failed session
        client.qr_code = null; 
        try {
            await client.destroy();
        } catch (e) {
            console.error("Failed to destroy client after auth failure:", e);
        }
        clients.delete(userId);
        return res.json({ 
            status: 'DISCONNECTED', // Or ERROR, but DISCONNECTED forces the UI to show the START button
            message: 'Authentication Failed. Please click Start/Generate QR to try again.'
        });
    }
    
    // State 4: Still initializing or loading session (no QR yet)
    return res.json({ status: 'STARTING', message: 'Session is initializing or waiting for QR code...' });
});


// ----------------------------------------------------
// API ENDPOINT 3: /disconnect (Session end)
// ----------------------------------------------------
app.post('/disconnect', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ status: 'ERROR', message: 'UserId is required.' });
    }

    const client = clients.get(userId);

    if (client) {
        try {
            // client.destroy() triggers the 'disconnected' event listener which handles cleanup
            await client.destroy(); 
            clients.delete(userId);
            return res.json({ status: 'DISCONNECTED', message: 'Session successfully disconnected and destroyed.' });
        } catch (e) {
            console.error(`Error destroying client for ${userId}:`, e);
            clients.delete(userId); 
            return res.status(500).json({ status: 'ERROR', message: 'Failed to destroy client. Manual cleanup performed.' });
        }
    } else {
        return res.json({ status: 'DISCONNECTED', message: 'No active session to disconnect.' });
    }
});


server.listen(port, () => {
    console.log(`WhatsApp Multi-User Service running on port ${port}`);
});
