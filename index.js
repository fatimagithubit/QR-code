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
  console.log(`Creating new client for ${userId}`);

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

  // QR Event
  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    clients[userId].qr = qrImage;
    console.log(`QR generated for ${userId}`);
  });

  // Ready Event
  client.on("ready", () => {
    console.log(`✅ WhatsApp client ready for ${userId}`);
    clients[userId].status = "connected";
  });

  client.on("disconnected", (reason) => {
    console.log(`⚠️ Disconnected for ${userId}: ${reason}`);
    clients[userId].status = "disconnected";
    client.destroy();
    delete clients[userId];
  });

  await client.initialize();
  clients[userId] = { client, status: "initializing" };
}

// Start Session
app.post("/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!clients[userId]) await createClient(userId);

  const qr = clients[userId]?.qr || null;
  const status = clients[userId]?.status || "initializing";
  res.json({ status, qr });
});

// Status
app.get("/status", (req, res) => {
  const userId = req.query.userId;
  const clientData = clients[userId];
  if (!clientData) return res.json({ status: "disconnected" });

  res.json({ status: clientData.status || "unknown" });
});

// Disconnect
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (clients[userId]) {
    await clients[userId].client.destroy();
    delete clients[userId];
    return res.json({ status: "disconnected" });
  }
  res.json({ status: "already_disconnected" });
});

// Root
app.get("/", (_, res) => res.send("✅ WhatsApp Gateway running!"));

app.listen(PORT, () => console.log(`✅ WhatsApp Gateway running on port ${PORT}`));
