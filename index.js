const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 10000;

// Folder for WhatsApp session data
const sessionDir = path.join(__dirname, "sessions");
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

// Simple homepage
app.get("/", (req, res) => {
  res.send("<h2>🚀 WhatsApp QR Service is Running Successfully!</h2>");
});

io.on("connection", (socket) => {
  console.log("New client connected ✅");

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "user-1",
      dataPath: sessionDir,
    }),
    puppeteer: {
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: true,
    },
  });

  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    socket.emit("qr", qrImage);
    console.log("📸 QR Code generated");
  });

  client.on("ready", () => {
    socket.emit("ready", "WhatsApp is connected ✅");
    console.log("✅ WhatsApp connected");
  });

  client.on("disconnected", (reason) => {
    socket.emit("disconnected", reason);
    console.log("❌ Disconnected:", reason);
  });

  client.initialize();

  socket.on("disconnect", () => {
    console.log("Client disconnected ❎");
  });
});

server.listen(PORT, () =>
  console.log(`🚀 WhatsApp Gateway running on port ${PORT}`)
);
