import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { App as SlackApp } from "@slack/bolt";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./auth.js";
import { pool } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OWNERS = (process.env.OWNERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const conversationAdminMap = new Map();
const adminDmChannelMap = new Map();
let ownerPointer = 0;
let ownersWarningShown = false;

function pickAdmin() {
  if (!OWNERS.length) {
    if (!ownersWarningShown) {
      console.warn("No owners configured. Set OWNERS to receive anonymous message alerts.");
      ownersWarningShown = true;
    }
    return null;
  }
  const selected = OWNERS[ownerPointer % OWNERS.length];
  ownerPointer += 1;
  return selected;
}

async function getAdminDmChannel(adminSlackId) {
  if (adminDmChannelMap.has(adminSlackId)) {
    return adminDmChannelMap.get(adminSlackId);
  }

  const result = await slack.client.conversations.open({ users: adminSlackId });
  const channelId = result.channel && result.channel.id;
  if (!channelId) {
    throw new Error(`Could not open admin DM for ${adminSlackId}`);
  }
  adminDmChannelMap.set(adminSlackId, channelId);
  return channelId;
}

async function isUserBlocked(slackId) {
  const blocked = await pool.query(
    "SELECT 1 FROM blocked_users WHERE slack_user_id=$1 LIMIT 1",
    [slackId]
  );
  return blocked.rows.length > 0;
}

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
app.get("/", (_req, res) => res.redirect("/login.html"));
app.get("/dashboard", requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

/* ---------- SLACK BOT ---------- */

const slack = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

/* ---------- AIRTABLE TO SLACK ---------- */

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const AIRTABLE_NOTIFY_CHANNEL_ID = process.env.SLACK_AIRTABLE_CHANNEL_ID;
const AIRTABLE_POLL_INTERVAL_MS = Number(process.env.AIRTABLE_POLL_INTERVAL_MS || 15000);
const AIRTABLE_SLACK_ID_FIELD = process.env.AIRTABLE_SLACK_ID_FIELD || "Slack ID";
const AIRTABLE_CUSTOM_MESSAGE_TEMPLATE = process.env.AIRTABLE_CUSTOM_MESSAGE_TEMPLATE || "{mention} your submission in {table} was {event}.";
const AIRTABLE_APPROVAL_FIELD = process.env.AIRTABLE_APPROVAL_FIELD || "Review Status";
const AIRTABLE_APPROVAL_VALUE = process.env.AIRTABLE_APPROVAL_VALUE || "Approved";
const AIRTABLE_NOTIFY_MODE = (process.env.AIRTABLE_NOTIFY_MODE || "dm").toLowerCase();
const AIRTABLE_NOTIFY_ON_INIT_APPROVED = (process.env.AIRTABLE_NOTIFY_ON_INIT_APPROVED || "true").toLowerCase() === "true";
const AIRTABLE_MAIL_STATUS_FIELD = process.env.AIRTABLE_MAIL_STATUS_FIELD || "Mail Status";
const AIRTABLE_MAIL_STATUS_SHIPPED_VALUE = process.env.AIRTABLE_MAIL_STATUS_SHIPPED_VALUE || "Shipped";
const AIRTABLE_NOTIFY_FIELDS = (process.env.AIRTABLE_NOTIFY_FIELDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AIRTABLE_SECOND_TABLE_NAME = process.env.AIRTABLE_SECOND_TABLE_NAME;
const AIRTABLE_SECOND_NOTIFY_CHANNEL_ID = process.env.SLACK_AIRTABLE_SECOND_CHANNEL_ID;
const AIRTABLE_SECOND_SLACK_ID_FIELD = process.env.AIRTABLE_SECOND_SLACK_ID_FIELD || AIRTABLE_SLACK_ID_FIELD;
const AIRTABLE_SECOND_CUSTOM_MESSAGE_TEMPLATE = process.env.AIRTABLE_SECOND_CUSTOM_MESSAGE_TEMPLATE || "{mention} your record in {table} was {event}.";
const AIRTABLE_SECOND_STATUS_FIELD = process.env.AIRTABLE_SECOND_STATUS_FIELD || "Status";
const AIRTABLE_SECOND_REJECTED_VALUE = process.env.AIRTABLE_SECOND_REJECTED_VALUE || "Rejected";
const AIRTABLE_SECOND_NOTIFY_FIELDS = (process.env.AIRTABLE_SECOND_NOTIFY_FIELDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const seenAirtableRecords = new Map();
const seenAirtableSecondRecords = new Map();
let airtableInitialized = false;
let airtableSecondInitialized = false;
let airtableConfigWarningShown = false;
let airtableSecondConfigWarningShown = false;

function isAirtableConfigured() {
  return Boolean(
    AIRTABLE_API_KEY &&
    AIRTABLE_BASE_ID &&
    AIRTABLE_TABLE_NAME
  );
}

function isSecondAirtableConfigured() {
  return Boolean(
    AIRTABLE_API_KEY &&
    AIRTABLE_BASE_ID &&
    AIRTABLE_SECOND_TABLE_NAME &&
    AIRTABLE_SECOND_NOTIFY_CHANNEL_ID &&
    !AIRTABLE_SECOND_NOTIFY_CHANNEL_ID.includes("...")
  );
}

function normalizeSlackId(rawValue) {
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      const normalized = normalizeSlackId(item);
      if (normalized) return normalized;
    }
    return null;
  }

  if (rawValue === undefined || rawValue === null) return null;

  const value = String(rawValue).trim();
  if (!value) return null;

  const mentionMatch = value.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return mentionMatch[1];

  return value;
}

function getRecordFingerprint(record) {
  return JSON.stringify(record.fields || {});
}

function isApprovedRecord(record) {
  const fields = record.fields || {};
  const raw = fields[AIRTABLE_APPROVAL_FIELD];

  if (raw === undefined || raw === null) {
    return false;
  }

  if (Array.isArray(raw)) {
    return raw.some((value) => String(value).trim().toLowerCase() === AIRTABLE_APPROVAL_VALUE.toLowerCase());
  }

  return String(raw).trim().toLowerCase() === AIRTABLE_APPROVAL_VALUE.toLowerCase();
}

function isMailStatusShipped(fields = {}) {
  const raw = fields[AIRTABLE_MAIL_STATUS_FIELD];

  if (raw === undefined || raw === null) {
    return false;
  }

  if (Array.isArray(raw)) {
    return raw.some((value) => String(value).trim().toLowerCase() === AIRTABLE_MAIL_STATUS_SHIPPED_VALUE.toLowerCase());
  }

  return String(raw).trim().toLowerCase() === AIRTABLE_MAIL_STATUS_SHIPPED_VALUE.toLowerCase();
}

function didMailStatusChange(previousFields = {}, currentFields = {}) {
  return JSON.stringify(previousFields[AIRTABLE_MAIL_STATUS_FIELD]) !== JSON.stringify(currentFields[AIRTABLE_MAIL_STATUS_FIELD]);
}

function getSecondTableStatusValue(fields = {}) {
  const raw = fields[AIRTABLE_SECOND_STATUS_FIELD];

  if (raw === undefined || raw === null) {
    return "";
  }

  if (Array.isArray(raw)) {
    const first = raw.find((value) => String(value).trim().length > 0);
    return first ? String(first).trim().toLowerCase() : "";
  }

  return String(raw).trim().toLowerCase();
}

function shouldHideFieldKey(key) {
  const normalized = String(key).trim().toLowerCase();
  return normalized.includes("email") || normalized.includes("last updated") || normalized.includes("record id");
}

function buildCustomMessage(record, slackId, isNew, tableName, template) {
  const fields = record.fields || {};
  // Always mention the user for Workshops
  const mentionValue = tableName === 'Workshops' ? '<@U082UPTRQU8>' : (slackId ? `<@${slackId}>` : "User");
  const tokens = {
    mention: mentionValue,
    slackId: slackId || "",
    table: tableName,
    event: isNew ? "created" : "updated",
  };

  const tokenEntries = Object.entries(tokens);
  const fieldEntries = Object.entries(fields);

  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    const trimmedKey = String(key).trim();
    const normalizedKey = trimmedKey.toLowerCase();

    const tokenMatch = tokenEntries.find(([tokenKey]) => tokenKey.toLowerCase() === normalizedKey);
    if (tokenMatch) {
      return tokenMatch[1];
    }

    const fieldMatch = fieldEntries.find(([fieldKey]) => String(fieldKey).trim().toLowerCase() === normalizedKey);
    if (fieldMatch) {
      const [fieldKey, value] = fieldMatch;
      if (shouldHideFieldKey(fieldKey)) {
        return "";
      }
      if (Array.isArray(value)) return value.join(", ");
      if (value === undefined || value === null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }
    return match;
  });
}

function formatAirtableRecord(record, slackId, isNew, config) {
  const {
    tableName,
    notifyFields,
    messageTemplate,
  } = config;

  const fields = record.fields || {};
  const pickedKeys = notifyFields.length
    ? notifyFields
    : Object.keys(fields).slice(0, 5);

  const safeKeys = pickedKeys.filter((key) => !shouldHideFieldKey(key));

  const lines = safeKeys.map((key) => {
    const value = fields[key];
    if (value === undefined || value === null || value === "") {
      return `• *${key}:* _empty_`;
    }
    if (Array.isArray(value)) {
      return `• *${key}:* ${value.join(", ")}`;
    }
    if (typeof value === "object") {
      return `• *${key}:* ${JSON.stringify(value)}`;
    }
    return `• *${key}:* ${String(value)}`;
  });

  const emoji = isNew ? "🆕" : "📝";
  const status = isNew ? "New" : "Updated";
  const customMessage = buildCustomMessage(record, slackId, isNew, tableName, messageTemplate);

  return [
    customMessage,
    `${emoji} *${status}* entry in *${tableName}*`,
    ...lines,
  ].join("\n");
}

async function fetchAirtableRecords(tableName) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}?pageSize=100`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.records || [];
}

async function sendFirstTableNotification(record, options = {}) {
  const { forceDmOnly = false } = options;
  const slackId = normalizeSlackId((record.fields || {})[AIRTABLE_SLACK_ID_FIELD]);
  
  if (!slackId) {
    console.warn(`Skipped Airtable update ${record.id}: missing Slack ID field '${AIRTABLE_SLACK_ID_FIELD}'.`);
    return;
  }

  const messageText = formatAirtableRecord(record, slackId, false, {
    tableName: AIRTABLE_TABLE_NAME,
    notifyFields: AIRTABLE_NOTIFY_FIELDS,
    messageTemplate: AIRTABLE_CUSTOM_MESSAGE_TEMPLATE,
  });

  const isApproved = isApprovedRecord(record);

  if (forceDmOnly) {
    await slack.client.chat.postMessage({
      channel: slackId,
      text: messageText,
    });
    return;
  }

  if (isApproved) {
    // Approved: send DM and post to channel.
    await slack.client.chat.postMessage({
      channel: slackId,
      text: messageText,
    });

    if (AIRTABLE_NOTIFY_CHANNEL_ID) {
      await slack.client.chat.postMessage({
        channel: AIRTABLE_NOTIFY_CHANNEL_ID,
        text: messageText,
      });
    }
  } else {
    // Not approved: send DM only
    await slack.client.chat.postMessage({
      channel: slackId,
      text: messageText,
    });
  }
}

async function pollAirtableAndNotify() {
  if (!isAirtableConfigured()) {
    if (!airtableConfigWarningShown) {
      console.warn("Airtable integration is disabled: missing required env vars.");
      airtableConfigWarningShown = true;
    }
    return;
  }

  const records = await fetchAirtableRecords(AIRTABLE_TABLE_NAME);

  if (!airtableInitialized) {
    const approvedOnInit = [];
    for (const record of records) {
      seenAirtableRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
      if (AIRTABLE_NOTIFY_ON_INIT_APPROVED && isApprovedRecord(record)) {
        approvedOnInit.push(record);
      }
    }
    airtableInitialized = true;
    console.log(`Airtable watcher initialized with ${records.length} existing records.`);

    for (const record of approvedOnInit) {
      await sendFirstTableNotification(record);
    }
    return;
  }

  const changedRecords = [];

  for (const record of records) {
    const seen = seenAirtableRecords.get(record.id);

    if (!seen) {
      seenAirtableRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
    } else if (getRecordFingerprint(record) !== seen.fingerprint) {
      changedRecords.push({
        record,
        previousFields: seen.fields || {},
      });
      seenAirtableRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
    }
  }

  for (const { record, previousFields } of changedRecords) {
    const mailStatusChanged = didMailStatusChange(previousFields, record.fields || {});

    const shippedNow = isMailStatusShipped(record.fields || {});
    const shippedBefore = isMailStatusShipped(previousFields);
    if (shippedNow && !shippedBefore) {
      console.log(`Airtable record ${record.id} mail status changed to '${AIRTABLE_MAIL_STATUS_SHIPPED_VALUE}'. Sending Slack DM only.`);
    }

    if (mailStatusChanged) {
      await sendFirstTableNotification(record, { forceDmOnly: true });
      continue;
    }

    await sendFirstTableNotification(record);
  }
}

async function pollSecondAirtableAndNotify() {
  if (!isSecondAirtableConfigured()) {
    if (!airtableSecondConfigWarningShown) {
      console.warn("Second Airtable integration is disabled: missing required env vars.");
      airtableSecondConfigWarningShown = true;
    }
    return;
  }

  const records = await fetchAirtableRecords(AIRTABLE_SECOND_TABLE_NAME);

  if (!airtableSecondInitialized) {
    for (const record of records) {
      seenAirtableSecondRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
    }
    airtableSecondInitialized = true;
    console.log(`Second Airtable watcher initialized with ${records.length} existing records.`);
    return;
  }

  const changedRecords = [];

  for (const record of records) {
    const seen = seenAirtableSecondRecords.get(record.id);

    if (!seen) {
      seenAirtableSecondRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
      continue;
    }

    if (getRecordFingerprint(record) !== seen.fingerprint) {
      changedRecords.push({
        record,
        previousFields: seen.fields || {},
      });
      seenAirtableSecondRecords.set(record.id, {
        fingerprint: getRecordFingerprint(record),
        fields: record.fields || {},
      });
    }
  }

  for (const { record, previousFields } of changedRecords) {
    const statusNow = getSecondTableStatusValue(record.fields || {});
    const statusBefore = getSecondTableStatusValue(previousFields);

    if (!statusNow || statusNow === statusBefore) {
      continue;
    }

    const slackId = normalizeSlackId((record.fields || {})[AIRTABLE_SECOND_SLACK_ID_FIELD]);
    if (!slackId) {
      console.warn(`Skipped ${AIRTABLE_SECOND_TABLE_NAME} status update ${record.id}: missing Slack ID field '${AIRTABLE_SECOND_SLACK_ID_FIELD}'.`);
      continue;
    }


    let messageTemplate = AIRTABLE_SECOND_CUSTOM_MESSAGE_TEMPLATE;
    if (statusNow === AIRTABLE_SECOND_REJECTED_VALUE.toLowerCase()) {
      messageTemplate = process.env.AIRTABLE_SECOND_REJECTED_MESSAGE_TEMPLATE || 'Hey {mention}, your workshop was rejected. Please contact support if you have questions.';
    } else if (statusNow === 'closed') {
      messageTemplate = process.env.AIRTABLE_SECOND_CLOSED_MESSAGE_TEMPLATE || 'Hey {mention}, your enclosure workshop is now closed. Please ensure all submissions are complete. If you have questions, contact the admin.';
    }
    const messageText = formatAirtableRecord(record, slackId, false, {
      tableName: AIRTABLE_SECOND_TABLE_NAME,
      notifyFields: AIRTABLE_SECOND_NOTIFY_FIELDS,
      messageTemplate,
    });

    await slack.client.chat.postMessage({
      channel: slackId,
      text: messageText,
    });

    // Only send to channel if not rejected
    if (statusNow !== AIRTABLE_SECOND_REJECTED_VALUE.toLowerCase()) {
      await slack.client.chat.postMessage({
        channel: AIRTABLE_SECOND_NOTIFY_CHANNEL_ID,
        text: messageText,
      });
    }
  }
}

slack.event("message", async ({ event }) => {
  if (event.subtype || event.channel_type !== "im") return;

  const slackId = event.user;
  const text = (event.text || "").trim();
  if (!text) return;

  if (OWNERS.includes(slackId)) {
    return;
  }

  if (await isUserBlocked(slackId)) {
    await slack.client.chat.postMessage({
      channel: event.channel,
      text: "Your account is blocked from sending anonymous messages.",
    });
    return;
  }

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

  let isNewConversation = false;
  if (convo.rows.length === 0) {
    convo = await pool.query(
      "INSERT INTO conversations (slack_user_id) VALUES ($1) RETURNING *",
      [slackId]
    );
    isNewConversation = true;
  }

  const conversationId = convo.rows[0].id;

  if (!conversationAdminMap.has(conversationId)) {
    conversationAdminMap.set(conversationId, pickAdmin());
  }

  // save message
  await pool.query(
    "INSERT INTO messages (conversation_id, sender, content) VALUES ($1,'user',$2)",
    [conversationId, text]
  );

  if (isNewConversation) {
    await slack.client.chat.postMessage({
      channel: event.channel,
      text: `Your anonymous thread has been created. Reference ID: #${conversationId}`,
    });
  }

  const assignedAdmin = conversationAdminMap.get(conversationId);
  if (assignedAdmin) {
    const adminDm = await getAdminDmChannel(assignedAdmin);
    const prefix = isNewConversation ? "NEW" : "UPDATE";
    await slack.client.chat.postMessage({
      channel: adminDm,
      text: `[${prefix}] Anonymous message #${conversationId}\nFrom user: ${slackId}\n\n${text}`,
    });
  }
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
  const replyText = (text || "").trim();

  if (!conversationId || !replyText) {
    return res.status(400).json({ ok: false, error: "conversationId and text are required" });
  }

  const convo = await pool.query(
    "SELECT * FROM conversations WHERE id=$1",
    [conversationId]
  );

  if (convo.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Conversation not found" });
  }

  if (convo.rows[0].status !== "open") {
    return res.status(400).json({ ok: false, error: "Conversation is not open" });
  }

  const slackUserId = convo.rows[0].slack_user_id;

  await slack.client.chat.postMessage({
    channel: slackUserId,
    text: `Admin reply on #${conversationId}:\n${replyText}`,
  });

  await pool.query(
    "INSERT INTO messages (conversation_id, sender, content) VALUES ($1,'admin',$2)",
    [conversationId, replyText]
  );

  res.json({ ok: true });
});

app.post("/api/conversations/:id/close", requireAdmin, async (req, res) => {
  const conversationId = req.params.id;
  const convo = await pool.query(
    "UPDATE conversations SET status='closed' WHERE id=$1 AND status='open' RETURNING *",
    [conversationId]
  );

  if (convo.rows.length === 0) {
    return res.status(400).json({ ok: false, error: "Conversation is not open" });
  }

  await slack.client.chat.postMessage({
    channel: convo.rows[0].slack_user_id,
    text: `Conversation #${conversationId} has been closed by admin.`,
  });

  res.json({ ok: true });
});

app.post("/api/conversations/:id/block", requireAdmin, async (req, res) => {
  const conversationId = req.params.id;
  const convo = await pool.query(
    "UPDATE conversations SET status='blocked' WHERE id=$1 AND status='open' RETURNING *",
    [conversationId]
  );

  if (convo.rows.length === 0) {
    return res.status(400).json({ ok: false, error: "Conversation is not open" });
  }

  await pool.query(
    "INSERT INTO blocked_users (slack_user_id, blocked_by) VALUES ($1, $2) ON CONFLICT (slack_user_id) DO NOTHING",
    [convo.rows[0].slack_user_id, req.session.admin]
  );

  await slack.client.chat.postMessage({
    channel: convo.rows[0].slack_user_id,
    text: "Your account has been blocked from anonymous messaging.",
  });

  res.json({ ok: true });
});


(async () => {
  await slack.start(3001); // Slack events
  app.listen(process.env.PORT, () =>
    console.log("🌐 Dashboard running on port", process.env.PORT)
  );

  setInterval(async () => {
    try {
      await Promise.all([
        pollAirtableAndNotify(),
        pollSecondAirtableAndNotify(),
      ]);
    } catch (error) {
      console.error("Airtable poll failed:", error.message);
    }
  }, AIRTABLE_POLL_INTERVAL_MS);

  // Run once immediately so polling starts without waiting for the interval.
  try {
    await Promise.all([
      pollAirtableAndNotify(),
      pollSecondAirtableAndNotify(),
    ]);
  } catch (error) {
    console.error("Initial Airtable poll failed:", error.message);
  }
})();
