const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const ZERO_WIDTH_SPACE = '\u200B'; 

// --- Multi-User State Management ---
const clients = {};

// --- Helper Functions ---

function createClientInstance(userId) {
    if (clients[userId] && clients[userId].status !== 'DISCONNECTED') {
        return clients[userId].client;
    }

    console.log(`[USER ${userId}] Creating new client instance.`);
    
    const sessionPath = `whatsapp_session_${userId}`;
    
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
                '--disable-gpu'
            ],
        },
    });

    clients[userId] = {
        client: client,
        status: 'DISCONNECTED',
        qrData: null,
        info: null,
    };

    client.on('qr', (qr) => {
        console.log(`[USER ${userId}] QR RECEIVED`);
        clients[userId].status = 'QR_READY';
        qrcode.toDataURL(qr, (err, url) => {
            clients[userId].qrData = err ? null : url.split(',')[1];
        });
    });

    client.on('ready', () => {
        console.log(`[USER ${userId}] Client is READY! (CONNECTED)`);
        clients[userId].status = 'CONNECTED';
        clients[userId].info = client.info;
        clients[userId].qrData = null;
    });

    client.on('disconnected', (reason) => {
        console.log(`[USER ${userId}] Client was DISCONNECTED: ${reason}`);
        clients[userId].status = 'DISCONNECTED';
        clients[userId].info = null;
        clients[userId].qrData = null;
    });

    client.on('auth_failure', (msg) => {
        console.error(`[USER ${userId}] Authentication Failure:`, msg);
        clients[userId].status = 'AUTH_FAILED';
        clients[userId].qrData = null;
        const folderPath = path.join(process.cwd(), sessionPath);
        if (fs.existsSync(folderPath)) {
            fs.rmdirSync(folderPath, { recursive: true });
            console.log(`[USER ${userId}] Deleted corrupted session folder.`);
        }
    });

    return client;
}

function getClientState(userId) {
    return clients[userId] || {
        status: 'DISCONNECTED',
        qrData: null,
        connection_info: null
    };
}

// JSON body parser limit ko media files ke liye badhaya gaya gaya hai.
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// --- API Endpoints ---

app.post('/start', (req, res) => {
    const { userId } = req.body;
    if (!userId) { return res.status(400).json({ message: 'Missing userId in request body.' }); }

    const state = getClientState(userId);

    if (state.status === 'CONNECTED' || state.status === 'QR_READY') {
        return res.status(200).json({ message: 'Session is already active or initializing.', status: state.status });
    }

    try {
        const client = createClientInstance(userId);
        clients[userId].status = 'STARTING';
        
        console.log(`[USER ${userId}] Initializing client...`);
        client.initialize().catch(err => {
            console.error(`[USER ${userId}] Initialization failed:`, err);
            clients[userId].status = 'DISCONNECTED';
        });
        
        res.status(202).json({ message: 'Initialization started. Poll /status for QR code.' });
    } catch (e) {
        console.error(`[USER ${userId}] Failed to create client:`, e);
        res.status(500).json({ message: 'Failed to start client initialization.', error: e.toString() });
    }
});

app.get('/status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) { return res.status(400).json({ message: 'Missing userId query parameter.' }); }

    const state = getClientState(userId);
    
    res.json({
        status: state.status,
        qr: state.qrData,
        connection_info: state.info ? {
            name: state.info.pushname,
            number: state.info.me.user
        } : null
    });
});

app.post('/disconnect', async (req, res) => {
    const { userId } = req.body;
    if (!userId) { return res.status(400).json({ message: 'Missing userId in request body.' }); }

    const state = getClientState(userId);
    const client = clients[userId]?.client;

    if (!client || state.status === 'DISCONNECTED') {
        return res.status(200).json({ message: 'Client already disconnected or not initialized.' });
    }

    try {
        console.log(`[USER ${userId}] Disconnecting client...`);
        await client.destroy();
        clients[userId].status = 'DISCONNECTED';
        clients[userId].qrData = null;
        clients[userId].info = null;
        
        const sessionPath = `whatsapp_session_${userId}`;
        const folderPath = path.join(process.cwd(), sessionPath);
        if (fs.existsSync(folderPath)) {
            fs.rmdirSync(folderPath, { recursive: true });
            console.log(`[USER ${userId}] Deleted local session data.`);
        }

        res.json({ message: 'Successfully destroyed session and disconnected.' });
    } catch (err) {
        console.error(`[USER ${userId}] Error during disconnect/destroy:`, err);
        clients[userId].status = 'DISCONNECTED';
        res.status(500).json({ message: 'Error during disconnect.', error: err.toString() });
    }
});

app.post('/send', async (req, res) => {
 
    const { userId, number, message, media_attachments } = req.body;
    
    
    if (!userId || !number) {
        return res.status(400).json({ success: false, message: 'userId aur Number dono zaroori hain.' });
    }

    
    const isMediaPresent = Array.isArray(media_attachments) && media_attachments.length > 0;
    
    let finalMessage = message || '';

    
    if (!isMediaPresent && finalMessage.trim() === '') {
        return res.status(400).json({
            success: false,
            message: 'userId, Number, and message are required. Message content ya kam se kam ek media file zaroori hai.'
        });
    }
    
    const clientState = getClientState(userId);
    const client = clients[userId]?.client;

    if (!client || clientState.status !== 'CONNECTED') {
        return res.status(400).json({ success: false, message: `WhatsApp client for user ${userId} connected nahi hai (Status: ${clientState.status}).` });
    }
    
    const chatId = `${number.replace(/[^0-9]/g, '')}@c.us`;
    
    try {
        let messageResponse = null;
        
        if (isMediaPresent) {
            const responses = [];
            // Loop through each attachment and send it individually
            for (let i = 0; i < media_attachments.length; i++) {
                const file = media_attachments[i];

                // Ensure the file object is valid before creating media
                if (!file || !file.data || !file.mimetype) {
                    console.warn(`[USER ${userId}] Skipping media file at index ${i}: Missing data or mimetype.`);
                    continue;
                }

                const media = new MessageMedia(file.mimetype, file.data, file.filename);
                
                // The main message/caption is only sent with the *first* file.
                const options = {};
                if (i === 0) {
                    options.caption = finalMessage;
                }

                const response = await client.sendMessage(chatId, media, options);
                responses.push(response.id.id);
            }
            messageResponse = { ids: responses }; // Store all sent message IDs
            
            // If the loop finished but no files were actually sent
            if (responses.length === 0) {
                 return res.status(500).json({ success: false, message: 'No media files could be sent successfully.' });
            }

        } else {
            // Text-only message for campaigns without any media
            messageResponse = await client.sendMessage(chatId, finalMessage);
        }

        console.log(`[USER ${userId}] Message(s) sent successfully.`);
        res.json({ success: true, message: `${isMediaPresent ? messageResponse.ids.length : 1} messages sent to ${number}.` });
    } catch (error) {
        console.error(`[USER ${userId}] ERROR SENDING TO ${number}:`, error.message || error.toString());
        
        res.status(500).json({
            success: false,
            message: 'Message bhejte samay internal WhatsApp error hua.',
            error: error.message || error.toString()
        });
    }
});

app.listen(PORT, () => {
    console.log(`WhatsApp Multi-User Service running on http://localhost:${PORT}`);
});
