import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import { Boom } from "@hapi/boom";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {}; // store active sessions per user

// ===================================================================
// FUNCTION: CREATE NEW WHATSAPP SESSION
// ===================================================================
async function createSession(userId) {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${userId}`);
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["Dabang Web", "Chrome", "Windows"],
  });

  sessions[userId] = { sock, qr: null, connected: false };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[userId].qr = await qrcode.toDataURL(qr);
    }

    if (connection === "open") {
      sessions[userId].connected = true;
      sessions[userId].qr = null;
      console.log(`✅ ${userId} connected successfully`);
    } else if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`❌ ${userId} disconnected: ${reason}`);

      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => createSession(userId), 5000);
      } else {
        delete sessions[userId];
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ===================================================================
// ROUTE: START SESSION (GENERATE QR OR CONNECT)
// ===================================================================
app.post("/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ status: "ERROR", message: "Missing userId" });

  try {
    if (!sessions[userId]) {
      await createSession(userId);
      return res.json({ status: "INITIALIZING", message: "Starting WhatsApp session..." });
    }
    return res.json({ status: "RUNNING", message: "Session already active." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
});

// ===================================================================
// ROUTE: STATUS CHECK
// ===================================================================
app.get("/status", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ status: "ERROR", message: "Missing userId" });

  const session = sessions[userId];
  if (!session) return res.json({ status: "DISCONNECTED" });

  if (session.connected) {
    return res.json({
      status: "CONNECTED",
      connection_info: { name: userId },
    });
  } else if (session.qr) {
    return res.json({
      status: "QR_READY",
      qr: session.qr.split(",")[1], // base64 image for Django
    });
  } else {
    return res.json({ status: "INITIALIZING" });
  }
});

// ===================================================================
// ROUTE: DISCONNECT SESSION
// ===================================================================
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ status: "ERROR", message: "Missing userId" });

  const session = sessions[userId];
  if (!session) return res.json({ status: "DISCONNECTED" });

  try {
    await session.sock.logout();
    delete sessions[userId];
    return res.json({ status: "DISCONNECTED", message: "Session disconnected successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "ERROR", message: "Error while disconnecting." });
  }
});
// ===================================================================
// ROUTE: SEND MESSAGE (Used by Django or Admin Dashboard)
// ===================================================================
app.post("/send-message", async (req, res) => {
  const { userId, phone, message } = req.body;

  if (!userId || !phone || !message) {
    return res.status(400).json({
      status: "ERROR",
      message: "Missing required fields (userId, phone, message)",
    });
  }

  const session = sessions[userId];
  if (!session || !session.connected) {
    return res.status(400).json({
      status: "ERROR",
      message: "No active WhatsApp session found for this user.",
    });
  }

  try {
    const jid = phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    await session.sock.sendMessage(jid, { text: message });

    console.log(`📩 Message sent to ${phone} by ${userId}: ${message}`);
    return res.json({ status: "SUCCESS", message: "Message sent successfully!" });
  } catch (err) {
    console.error("❌ Message sending error:", err);
    return res.status(500).json({ status: "ERROR", message: "Failed to send message." });
  }
});


// ===================================================================
// SERVER START
// ===================================================================
const PORT = process.env.PORT || 8000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ WhatsApp Gateway successfully running on Render at port ${PORT}`);
});



