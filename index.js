const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const clients = {};
const SESSION_DIR = "./sessions";

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);

async function createClient(userId) {
  console.log(`🟢 Creating new client for ${userId}`);

  // Initialize record before events trigger
  clients[userId] = { status: "initializing", qr: null, client: null };

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: String(userId), dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
      executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome-stable",
    },
  });

  // --- Events ---
  client.on("qr", async (qr) => {
    try {
      const qrImage = await qrcode.toDataURL(qr);
      clients[userId].qr = qrImage;
      clients[userId].status = "qr";
      console.log(`📱 QR generated for ${userId}`);
    } catch (err) {
      console.error("QR generation failed:", err);
    }
  });

  client.on("ready", () => {
    clients[userId].status = "connected";
    clients[userId].qr = null;
    console.log(`✅ WhatsApp client ready for ${userId}`);
  });

  client.on("disconnected", (reason) => {
    console.log(`⚠️ Disconnected for ${userId}: ${reason}`);
    clients[userId].status = "disconnected";
    client.destroy();
    delete clients[userId];
  });

  clients[userId].client = client;

  try {
    await client.initialize();
  } catch (err) {
    console.error(`❌ Initialization failed for ${userId}:`, err);
    clients[userId].status = "error";
  }
}

// --- API Routes ---

app.post("/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!clients[userId]) await createClient(userId);

  const data = clients[userId];
  res.json({ status: data.status, qr: data.qr });
});

app.get("/status", (req, res) => {
  const userId = req.query.userId;
  const clientData = clients[userId];
  if (!clientData) return res.json({ status: "disconnected" });

  res.json({ status: clientData.status || "unknown" });
});

app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  const clientData = clients[userId];
  if (clientData) {
    await clientData.client.destroy();
    delete clients[userId];
    return res.json({ status: "disconnected" });
  }
  res.json({ status: "already_disconnected" });
});

app.get("/", (_, res) => res.send("✅ WhatsApp Gateway running!"));

app.listen(PORT, () =>
  console.log(`🚀 WhatsApp Gateway active on port ${PORT}`)
);
