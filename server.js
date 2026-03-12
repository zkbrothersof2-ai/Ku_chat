const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "ku-chat-basit-khan-secret-2024";

// ── DATABASE ──────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || "./ku_chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    invite_code TEXT UNIQUE NOT NULL,
    admin_id TEXT NOT NULL,
    admin_username TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_type TEXT DEFAULT 'guest',
    text TEXT NOT NULL,
    reply_to_id TEXT DEFAULT NULL,
    reply_to_name TEXT DEFAULT NULL,
    reply_to_text TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    username TEXT NOT NULL,
    joined_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(chat_id, username)
  );
`);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── WEBSOCKET ROOMS ───────────────────────────────────────────
// rooms: { chatId: Set<ws> }
const rooms = {};

function broadcast(chatId, data, excludeWs = null) {
  if (!rooms[chatId]) return;
  const msg = JSON.stringify(data);
  rooms[chatId].forEach(ws => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(msg);
  });
}

function broadcastAll(chatId, data) {
  if (!rooms[chatId]) return;
  const msg = JSON.stringify(data);
  rooms[chatId].forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.chatId = null;
  ws.username = null;
  ws.isAdmin = false;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // JOIN a chat room
    if (data.type === "join") {
      const { chatId, username, token } = data;
      const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
      if (!chat) return ws.send(JSON.stringify({ type: "error", msg: "Chat not found" }));

      // Check if admin token
      let isAdmin = false;
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          if (decoded && chat.admin_id === decoded.id) isAdmin = true;
        } catch {}
      }

      ws.chatId = chatId;
      ws.username = username;
      ws.isAdmin = isAdmin;

      if (!rooms[chatId]) rooms[chatId] = new Set();
      rooms[chatId].add(ws);

      // Save member
      try {
        db.prepare("INSERT OR IGNORE INTO members (id, chat_id, username) VALUES (?,?,?)")
          .run(uuidv4(), chatId, username);
      } catch {}

      // Send last 50 messages
      const history = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50"
      ).all(chatId).reverse();

      ws.send(JSON.stringify({ type: "history", messages: history, chat, isAdmin }));

      // Online count
      const onlineCount = rooms[chatId] ? rooms[chatId].size : 0;
      broadcastAll(chatId, { type: "online", count: onlineCount });

      // Notify others
      broadcast(chatId, {
        type: "system",
        msg: `${username} joined the chat`,
        time: Math.floor(Date.now() / 1000)
      }, ws);
    }

    // SEND a message
    else if (data.type === "message") {
      if (!ws.chatId || !ws.username) return;
      const text = (data.text || "").trim();
      if (!text || text.length > 1000) return;

      const msgId = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      const senderType = ws.isAdmin ? "admin" : "guest";
      const reply_to_id = data.reply_to_id || null;
      const reply_to_name = data.reply_to_name || null;
      const reply_to_text = data.reply_to_text ? String(data.reply_to_text).substring(0, 80) : null;

      db.prepare("INSERT INTO messages (id, chat_id, sender_name, sender_type, text, reply_to_id, reply_to_name, reply_to_text, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(msgId, ws.chatId, ws.username, senderType, text, reply_to_id, reply_to_name, reply_to_text, now);

      broadcastAll(ws.chatId, {
        type: "message",
        id: msgId,
        chat_id: ws.chatId,
        sender_name: ws.username,
        sender_type: senderType,
        text,
        reply_to_id,
        reply_to_name,
        reply_to_text,
        created_at: now
      });
    }

    // DELETE a message (admin only)
    else if (data.type === "delete_message") {
      if (!ws.isAdmin) return;
      const { msgId } = data;
      db.prepare("DELETE FROM messages WHERE id = ? AND chat_id = ?").run(msgId, ws.chatId);
      broadcastAll(ws.chatId, { type: "message_deleted", id: msgId });
    }

    // TYPING indicator
    else if (data.type === "typing") {
      if (!ws.chatId || !ws.username) return;
      broadcast(ws.chatId, { type: "typing", username: ws.username }, ws);
    }
  });

  ws.on("close", () => {
    if (ws.chatId && rooms[ws.chatId]) {
      rooms[ws.chatId].delete(ws);
      if (rooms[ws.chatId].size === 0) delete rooms[ws.chatId];
      else {
        broadcastAll(ws.chatId, { type: "online", count: rooms[ws.chatId].size });
        broadcast(ws.chatId, {
          type: "system",
          msg: `${ws.username} left the chat`,
          time: Math.floor(Date.now() / 1000)
        });
      }
    }
  });
});

// ── REST API ──────────────────────────────────────────────────

// Register admin
app.post("/api/register", async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: "All fields required" });
  if (username.length < 3) return res.status(400).json({ error: "Username min 3 chars" });
  if (password.length < 6) return res.status(400).json({ error: "Password min 6 chars" });
  if (!/^[a-z0-9_]+$/i.test(username)) return res.status(400).json({ error: "Username: letters/numbers/underscore only" });
  const exists = db.prepare("SELECT id FROM admins WHERE username=?").get(username.toLowerCase());
  if (exists) return res.status(409).json({ error: "Username already taken" });
  const hashed = await bcrypt.hash(password, 10);
  const id = uuidv4();
  db.prepare("INSERT INTO admins (id,username,name,password) VALUES (?,?,?,?)").run(id, username.toLowerCase(), name.trim(), hashed);
  const token = jwt.sign({ id, username: username.toLowerCase(), name: name.trim() }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, admin: { id, username: username.toLowerCase(), name: name.trim() } });
});

// Login admin
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "All fields required" });
  const admin = db.prepare("SELECT * FROM admins WHERE username=?").get(username.toLowerCase());
  if (!admin) return res.status(404).json({ error: "User not found" });
  const valid = await bcrypt.compare(password, admin.password);
  if (!valid) return res.status(401).json({ error: "Incorrect password" });
  const token = jwt.sign({ id: admin.id, username: admin.username, name: admin.name }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, admin: { id: admin.id, username: admin.username, name: admin.name } });
});

// Create chat (admin only)
app.post("/api/chats", authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Chat name required" });
  const id = uuidv4();
  const invite_code = Math.random().toString(36).substr(2, 8).toUpperCase();
  db.prepare("INSERT INTO chats (id,name,description,invite_code,admin_id,admin_username) VALUES (?,?,?,?,?,?)")
    .run(id, name.trim(), (description || "").trim(), invite_code, req.admin.id, req.admin.username);
  const chat = db.prepare("SELECT * FROM chats WHERE id=?").get(id);
  res.json(chat);
});

// Get my chats (admin)
app.get("/api/chats/mine", authMiddleware, (req, res) => {
  const chats = db.prepare("SELECT * FROM chats WHERE admin_id=? ORDER BY created_at DESC").all(req.admin.id);
  res.json(chats);
});

// Get all public chats
app.get("/api/chats", (req, res) => {
  const chats = db.prepare("SELECT id,name,description,invite_code,admin_username,created_at FROM chats ORDER BY created_at DESC").all();
  res.json(chats);
});

// Get chat by invite code
app.get("/api/invite/:code", (req, res) => {
  const chat = db.prepare("SELECT id,name,description,invite_code,admin_username,created_at FROM chats WHERE invite_code=?").get(req.params.code.toUpperCase());
  if (!chat) return res.status(404).json({ error: "Invalid invite link" });
  res.json(chat);
});

// Delete chat (admin only, must own it)
app.delete("/api/chats/:id", authMiddleware, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id=?").get(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  if (chat.admin_id !== req.admin.id) return res.status(403).json({ error: "Not your chat" });
  db.prepare("DELETE FROM messages WHERE chat_id=?").run(req.params.id);
  db.prepare("DELETE FROM members WHERE chat_id=?").run(req.params.id);
  db.prepare("DELETE FROM chats WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Stats
app.get("/api/stats", (req, res) => {
  const admins = db.prepare("SELECT COUNT(*) as c FROM admins").get();
  const chats = db.prepare("SELECT COUNT(*) as c FROM chats").get();
  const messages = db.prepare("SELECT COUNT(*) as c FROM messages").get();
  const members = db.prepare("SELECT COUNT(*) as c FROM members").get();
  res.json({ admins: admins.c, chats: chats.c, messages: messages.c, members: members.c });
});

// Serve frontend
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

server.listen(PORT, () => console.log(`✦ KU·Chat running on http://localhost:${PORT}`));
