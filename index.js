import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { App as SlackApp } from "@slack/bolt";
import authRoutes from "./auth.js";
import { pool } from "./db.js";

dotenv.config();

/* ---------- WEB SERVER ---------- */

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

app.use("/auth", authRoutes);

/* ---------- SLACK BOT ---------- */

const slack = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

slack.event("message", async ({ event }) => {
  if (event.subtype || event.channel_type !== "im") return;

  const slackId = event.user;
  const text = event.text;

  // create user if not exists
  await pool.query(
    "INSERT INTO users (slack_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [slackId]
  );

  // find open conversation
  let convo = await pool.query(
    "SELECT * FROM conversations WHERE slack_user_id=$1 AND status='open'",
    [slackId]
  );

  if (convo.rows.length === 0) {
    convo = await pool.query(
      "INSERT INTO conversations (slack_user_id) VALUES ($1) RETURNING *",
      [slackId]
    );
  }

  const conversationId = convo.rows[0].id;

  // save message
  await pool.query(
    "INSERT INTO messages (conversation_id, sender, content) VALUES ($1,'user',$2)",
    [conversationId, text]
  );
});

/* ---------- DASHBOARD AUTH ---------- */

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).end();
  next();
}

/* ---------- DASHBOARD APIs ---------- */

app.get("/api/conversations", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.slack_user_id, c.status, MAX(m.created_at) AS last_message
    FROM conversations c
    LEFT JOIN messages m ON c.id = m.conversation_id
    GROUP BY c.id
    ORDER BY last_message DESC
  `);
  res.json(rows);
});

app.get("/api/messages/:id", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at",
    [req.params.id]
  );
  res.json(rows);
});

app.post("/api/reply", requireAdmin, async (req, res) => {
  const { conversationId, text } = req.body;

  const convo = await pool.query(
    "SELECT * FROM conversations WHERE id=$1",
    [conversationId]
  );

  const slackUserId = convo.rows[0].slack_user_id;

  await slack.client.chat.postMessage({
    channel: slackUserId,
    text: `💬 Admin:\n${text}`,
  });

  await pool.query(
    "INSERT INTO messages (conversation_id, sender, content) VALUES ($1,'admin',$2)",
    [conversationId, text]
  );

  res.json({ ok: true });
});


(async () => {
  await slack.start(3001); // Slack events
  app.listen(process.env.PORT, () =>
    console.log("🌐 Dashboard running on port", process.env.PORT)
  );
})();
