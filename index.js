// Node.js WhatsApp Gateway (Polling Architecture)
// Compatible with Render + Django Integration

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.json());
const cors = require('cors');
app.use(cors({ origin: '*' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 🔹 Store clients in memory
const clients = new Map();

// ----------------------------------------------------
// HEALTH CHECKS / BASIC ROUTES
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'WhatsApp Gateway API is running successfully 🚀',
  });
});

// 🧠 ADD THIS NEW ROUTE — so that /api works
app.get('/api', (req, res) => {
  res.status(200).json({
    status: 'ACTIVE',
    message: 'WhatsApp API endpoint is working on Render 💚',
  });
});

// ----------------------------------------------------
// CREATE CLIENT FUNCTION
// ----------------------------------------------------
function createClientInstance(userId) {
  if (clients.has(userId)) return clients.get(userId);

  const sessionPath = `whatsapp_session_${userId}`;
  console.log(`Creating new client for ${userId}`);

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
        '--disable-gpu',
      ],
    },
  });

  client.qr_code = null;

  client.on('disconnected', async (reason) => {
    console.log(`Client ${userId} disconnected:`, reason);
    clients.delete(userId);
    try {
      await client.destroy();
    } catch {}
  });

  client.on('qr', async (qr) => {
    try {
      const qrDataURL = await qrcode.toDataURL(qr);
      client.qr_code = qrDataURL.split(',')[1];
      console.log(`QR Ready for user: ${userId}`);
    } catch (err) {
      console.error('QR Generation Error:', err);
    }
  });

  client.on('ready', () => {
    console.log(`Client READY for user: ${userId}`);
    client.qr_code = null;
  });

  client.on('auth_failure', (msg) => {
    console.error('AUTH FAILURE:', msg);
    client.qr_code = 'AUTH_FAILED';
  });

  clients.set(userId, client);
  return client;
}

// ----------------------------------------------------
// /start — Start WhatsApp Session
// ----------------------------------------------------
app.post('/start', async (req, res) => {
  const { userId } = req.body;

  if (!userId)
    return res.status(400).json({ status: 'ERROR', message: 'UserId required.' });

  const existing = clients.get(userId);
  if (existing && existing.info)
    return res.json({ status: 'CONNECTED', message: 'Already connected.' });

  const client = createClientInstance(userId);

  client
    .initialize()
    .then(() => console.log(`Initialized for ${userId}`))
    .catch((e) => console.error(`Initialization failed for ${userId}`, e));

  res.json({
    status: 'STARTING',
    message: 'Initialization started. Poll /status for updates.',
  });
});

// ----------------------------------------------------
// /status — Polling Endpoint
// ----------------------------------------------------
app.get('/status', async (req, res) => {
  const userId = req.query.userId || req.body.userId;
  if (!userId)
    return res.status(400).json({ status: 'ERROR', message: 'UserId required.' });

  const client = clients.get(userId);
  if (!client)
    return res.json({ status: 'DISCONNECTED', message: 'No active session.' });

  if (client.info) {
    return res.json({
      status: 'CONNECTED',
      message: 'Client connected successfully.',
      connection_info: {
        id: client.info.me.user,
        name: client.info.pushname || 'WhatsApp User',
      },
    });
  }

  if (client.qr_code && client.qr_code !== 'AUTH_FAILED') {
    return res.json({
      status: 'QR_READY',
      message: 'Scan QR Code to connect.',
      qr: client.qr_code,
    });
  }

  if (client.qr_code === 'AUTH_FAILED') {
    clients.delete(userId);
    try {
      await client.destroy();
    } catch {}
    return res.json({
      status: 'DISCONNECTED',
      message: 'Auth failed. Try again.',
    });
  }

  res.json({
    status: 'STARTING',
    message: 'Initializing or waiting for QR...',
  });
});

// ----------------------------------------------------
// /disconnect — End WhatsApp Session
// ----------------------------------------------------
app.post('/disconnect', async (req, res) => {
  const { userId } = req.body;
  if (!userId)
    return res.status(400).json({ status: 'ERROR', message: 'UserId required.' });

  const client = clients.get(userId);
  if (client) {
    try {
      await client.destroy();
      clients.delete(userId);
      res.json({
        status: 'DISCONNECTED',
        message: 'Session successfully disconnected.',
      });
    } catch (e) {
      res.status(500).json({
        status: 'ERROR',
        message: 'Failed to destroy client.',
      });
    }
  } else {
    res.json({ status: 'DISCONNECTED', message: 'No active session.' });
  }
});

server.listen(port, () => {
  console.log(`✅ WhatsApp Gateway running on port ${port}`);
});

