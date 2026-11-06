import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
// Render sits behind a trusted reverse proxy. This lets Express use the real
// visitor IP from the proxy rather than the proxy's own address.
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static("dist"));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = Number(process.env.PORT || 2567);
const players = new Map();
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const banFile = process.env.IP_BAN_FILE || path.join(serverDir, "data", "ip-bans.json");
const bannedIps = new Set();

try {
  const savedBans = JSON.parse(fs.readFileSync(banFile, "utf8"));
  if (Array.isArray(savedBans)) savedBans.forEach(ip => bannedIps.add(String(ip)));
} catch { /* First run: no ban file yet. */ }

function getClientIp(socket) {
  // Render supplies X-Forwarded-For from its edge proxy. Fall back to the
  // direct socket address for local development.
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : socket.handshake.address;
  return String(ip || "unknown").replace(/^::ffff:/, "");
}

function containsBannedSlur(message) {
  // Detect common spellings and simple punctuation/leet obfuscations without
  // storing or repeating the offensive term in chat.
  return /(?:^|[^a-z0-9])n[\W_]*[i1!][\W_]*[gq9][\W_]*[gq9][\W_]*(?:er|a|ah|uh)(?=$|[^a-z0-9])/i.test(message);
}

function persistBans() {
  try {
    fs.mkdirSync(path.dirname(banFile), { recursive: true });
    fs.writeFileSync(banFile, JSON.stringify([...bannedIps], null, 2));
  } catch (error) {
    console.error("Could not save IP bans:", error.message);
  }
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get("/health", (_req, res) => res.json({ ok: true, players: players.size }));
app.get("*", (_req, res, next) => {
  res.sendFile("index.html", { root: "dist" }, err => { if (err) next(); });
});

app.post("/api/ai", async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 500);
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  if (!message) return res.status(400).json({ error: "Write a message first." });

  if (!openai) {
    return res.json({
      reply: "I'm the little AI host in this demo. Add your OpenAI API key to the server's .env file to turn on full AI conversations. For now: what should we build or do in this world?"
    });
  }

  try {
    const input = [
      ...history.map(item => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: String(item.content || "").slice(0, 500)
      })),
      { role: "user", content: message }
    ];
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-6-mini",
      instructions: "You are the friendly AI host of a small, relaxed multiplayer social world. Be warm, concise, playful and inclusive. Help players chat, invent activities, and feel welcome. Do not claim you can see players or the world unless they tell you.",
      input,
      max_output_tokens: 180
    });
    res.json({ reply: response.output_text || "I lost my words for a second. Try me again?" });
  } catch (error) {
    console.error("AI request failed:", error.message);
    res.status(502).json({ error: "The AI couldn't reply just now. Check the server API key and model setting." });
  }
});

io.on("connection", socket => {
  const clientIp = getClientIp(socket);
  if (bannedIps.has(clientIp)) {
    socket.emit("chat:error", "You are banned from this server for abusive language.");
    socket.disconnect(true);
    return;
  }

  socket.on("join", rawName => {
    const name = String(rawName || "Guest").trim().slice(0, 18) || "Guest";
    const player = {
      id: socket.id,
      name,
      x: (Math.random() - 0.5) * 5,
      z: (Math.random() - 0.5) * 5,
      rotation: 0,
      colour: ["#f4a261", "#8ecae6", "#cdb4db", "#90be6d", "#ffafcc"][Math.floor(Math.random() * 5)]
    };
    players.set(socket.id, player);
    socket.emit("world:init", [...players.values()]);
    socket.broadcast.emit("player:joined", player);
    socket.emit("chat:message", { name: "WORLD", text: `Welcome, ${name}. Find your friends and have a wander!`, system: true });
  });

  socket.on("player:move", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    p.x = Math.max(-22, Math.min(22, Number(data.x) || 0));
    p.z = Math.max(-22, Math.min(22, Number(data.z) || 0));
    p.rotation = Number(data.rotation) || 0;
    socket.broadcast.emit("player:moved", p);
  });

  socket.on("chat:send", raw => {
    const p = players.get(socket.id);
    const text = String(raw || "").trim().slice(0, 240);
    if (!p || !text) return;

    if (containsBannedSlur(text)) {
      bannedIps.add(clientIp);
      persistBans();
      socket.emit("chat:error", "You have been banned from this server for racist language.");
      io.emit("chat:message", { name: "WORLD", text: `${p.name} was removed for abusive language.`, system: true });
      socket.disconnect(true);
      return;
    }

    io.emit("chat:message", { name: p.name, text, system: false });
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("player:left", socket.id);
  });
});

httpServer.listen(PORT, () => console.log(`Party World server running on http://localhost:${PORT}`));
