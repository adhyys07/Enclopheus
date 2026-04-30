import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./auth.js";
import { pool } from "./db.js";
import bolt from "@slack/bolt";

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { App: SlackApp, ExpressReceiver } = bolt;
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

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

const app = receiver.app;
app.use(express.json());
app.use(express.static("public"));

const PgSession = connectPgSimple(session);

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
  }),
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
  receiver,
});

/* ---------- AIRTABLE TO SLACK ---------- */

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const AIRTABLE_NOTIFY_CHANNEL_ID = process.env.SLACK_AIRTABLE_CHANNEL_ID;
const AIRTABLE_POLL_INTERVAL_MS = Number(process.env.AIRTABLE_POLL_INTERVAL_MS || 15000);
const AIRTABLE_SLACK_ID_FIELD = process.env.AIRTABLE_SLACK_ID_FIELD || "Slack ID";
const AIRTABLE_CUSTOM_MESSAGE_TEMPLATE = process.env.AIRTABLE_CUSTOM_MESSAGE_TEMPLATE || "{mention} your submission in {table} was {event}.";
const AIRTABLE_DM_CUSTOM_MESSAGE_TEMPLATE = process.env.AIRTABLE_DM_CUSTOM_MESSAGE_TEMPLATE || AIRTABLE_CUSTOM_MESSAGE_TEMPLATE;
const AIRTABLE_APPROVED_CHANNEL_MESSAGE_TEMPLATE = process.env.AIRTABLE_APPROVED_CHANNEL_MESSAGE_TEMPLATE || "{mention} your enclosure has been approved.";
const AIRTABLE_APPROVAL_FIELD = process.env.AIRTABLE_APPROVAL_FIELD || "Review Status";
const AIRTABLE_APPROVAL_VALUE = process.env.AIRTABLE_APPROVAL_VALUE || "Approved";
const AIRTABLE_PENDING_VALUE = process.env.AIRTABLE_PENDING_VALUE || "Pending";
const AIRTABLE_REJECTED_VALUE = process.env.AIRTABLE_REJECTED_VALUE || "Rejected";
const AIRTABLE_APPROVAL_MESSAGE_FIELD = process.env.AIRTABLE_APPROVAL_MESSAGE_FIELD || "Acceptance/Feedback";
const AIRTABLE_REJECTION_MESSAGE_FIELD = process.env.AIRTABLE_REJECTION_MESSAGE_FIELD || "Rejection Reason";
const AIRTABLE_JOURNAL_LINK_FIELD = process.env.AIRTABLE_JOURNAL_LINK_FIELD || "Journal Link";
const AIRTABLE_PLAYABLE_URL_FIELD = process.env.AIRTABLE_PLAYABLE_URL_FIELD || "Playable URL";
const AIRTABLE_NOTIFY_MODE = (process.env.AIRTABLE_NOTIFY_MODE || "dm").toLowerCase();
const AIRTABLE_NOTIFY_ON_INIT_APPROVED = (process.env.AIRTABLE_NOTIFY_ON_INIT_APPROVED || "true").toLowerCase() === "true";
const AIRTABLE_MAIL_STATUS_FIELD = process.env.AIRTABLE_MAIL_STATUS_FIELD || "Mail Status";
const AIRTABLE_MAIL_STATUS_SHIPPED_VALUE = process.env.AIRTABLE_MAIL_STATUS_SHIPPED_VALUE || "Shipped";
const AIRTABLE_NOTIFY_FIELDS = (process.env.AIRTABLE_NOTIFY_FIELDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Grant field notification
const AIRTABLE_GRANT_FIELD = process.env.AIRTABLE_GRANT_FIELD || "Grant";
const AIRTABLE_GRANT_GRANTED_VALUE = process.env.AIRTABLE_GRANT_GRANTED_VALUE || "Granted";
const AIRTABLE_GRANT_GRANTED_MESSAGE_TEMPLATE = process.env.AIRTABLE_GRANT_GRANTED_MESSAGE_TEMPLATE || "🎉 {mention} your grant has been *Granted*!";
const AIRTABLE_GRANT_LINK_FIELD = process.env.AIRTABLE_GRANT_LINK_FIELD || "Grant Link";

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
const recentGreetingEvents = new Set();
let airtableInitialized = false;
let airtableSecondInitialized = false;
let airtableConfigWarningShown = false;
let airtableSecondConfigWarningShown = false;

function isGreetingForEnclopheus(text = "") {
  const input = String(text);
  const hasGreeting = /\b(?:heyo|hello|hi|hey)\b/i.test(input);
  const hasNameOrMention = /\benclopheus\b/i.test(input) || /<@[A-Z0-9]+>/i.test(input);
  return hasGreeting && hasNameOrMention;
}

async function maybeReplyGreeting(event) {
  const text = (event && event.text ? event.text : "").trim();
  if (!text) return false;

  if (event.subtype || event.bot_id) return false;
  if (!isGreetingForEnclopheus(text)) return false;
  if (event.channel_type === "im") return false;

  const fallbackKey = `${event.channel || ""}:${event.thread_ts || event.ts || ""}:${text.toLowerCase()}`;
  const greetingEventKey = `${event.channel || ""}:${event.client_msg_id || event.event_ts || event.ts || fallbackKey}`;
  if (recentGreetingEvents.has(greetingEventKey)) {
    return true;
  }
  recentGreetingEvents.add(greetingEventKey);
  setTimeout(() => recentGreetingEvents.delete(greetingEventKey), 10 * 60 * 1000);

  await slack.client.chat.postMessage({
    channel: event.channel,
    text: "heyo gng!",
    thread_ts: event.thread_ts || event.ts,
  });

  return true;
}

async function ensureSubmissionReviewStatusesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submission_review_statuses (
      airtable_record_id TEXT PRIMARY KEY,
      slack_user_id TEXT,
      review_status TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_submission_review_status_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS submission_review_statuses_updated_at ON submission_review_statuses`);
  await pool.query(`
    CREATE TRIGGER submission_review_statuses_updated_at
    BEFORE UPDATE ON submission_review_statuses
    FOR EACH ROW
    EXECUTE FUNCTION set_submission_review_status_updated_at();
  `);
}

async function ensureSubmissionNotificationStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submission_notification_state (
      airtable_record_id TEXT PRIMARY KEY,
      notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
      last_notified_review_status TEXT,
      last_notified_review_updated_at TIMESTAMP,
      last_notified_fingerprint TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE submission_notification_state ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE submission_notification_state ADD COLUMN IF NOT EXISTS last_notified_review_status TEXT`);
  await pool.query(`ALTER TABLE submission_notification_state ADD COLUMN IF NOT EXISTS last_notified_review_updated_at TIMESTAMP`);
  await pool.query(`ALTER TABLE submission_notification_state ADD COLUMN IF NOT EXISTS last_notified_fingerprint TEXT NOT NULL DEFAULT ''`);
  await pool.query(`
    UPDATE submission_notification_state
    SET notification_sent = TRUE
    WHERE notification_sent = FALSE AND COALESCE(last_notified_fingerprint, '') <> ''
  `);
}

async function seedSubmissionNotificationStateFromReviewStatuses() {
  await pool.query(`
    INSERT INTO submission_notification_state (
      airtable_record_id,
      notification_sent,
      last_notified_review_status,
      last_notified_review_updated_at,
      last_notified_fingerprint,
      updated_at
    )
    SELECT
      airtable_record_id,
      TRUE,
      review_status,
      updated_at,
      '',
      CURRENT_TIMESTAMP
    FROM submission_review_statuses
    ON CONFLICT (airtable_record_id) DO NOTHING
  `);
}

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

function getReviewStatusFromRecord(record) {
  const fields = record.fields || {};
  const raw = fields[AIRTABLE_APPROVAL_FIELD];

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return "pending";
  }

  const normalizeStatusText = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const approvedValue = normalizeStatusText(AIRTABLE_APPROVAL_VALUE);
  const pendingValue = normalizeStatusText(AIRTABLE_PENDING_VALUE);
  const rejectedValue = normalizeStatusText(AIRTABLE_REJECTED_VALUE);

  const matchesStatusValue = (candidate, target) => {
    if (!candidate || !target) return false;
    return candidate === target || candidate.includes(target);
  };

  if (Array.isArray(raw)) {
    const normalizedValues = raw.map((value) => normalizeStatusText(value));
    if (normalizedValues.some((value) => matchesStatusValue(value, approvedValue))) return "approved";
    if (normalizedValues.some((value) => matchesStatusValue(value, pendingValue))) return "pending";
    if (normalizedValues.some((value) => matchesStatusValue(value, rejectedValue))) return "rejected";
    return "pending";
  }

  const normalized = normalizeStatusText(raw);
  if (matchesStatusValue(normalized, approvedValue)) return "approved";
  if (matchesStatusValue(normalized, pendingValue)) return "pending";
  if (matchesStatusValue(normalized, rejectedValue)) return "rejected";

  return "pending";
}

function getReviewStatusFromFields(fields = {}) {
  return getReviewStatusFromRecord({ fields });
}

function normalizeReviewStatus(statusValue) {
  const normalized = String(statusValue || "").trim().toLowerCase();
  if (normalized === "approved" || normalized === "pending" || normalized === "rejected") {
    return normalized;
  }
  return "pending";
}

function getReviewStatusLabel(statusValue) {
  const normalized = normalizeReviewStatus(statusValue);
  if (normalized === "approved") return "Approved";
  if (normalized === "rejected") return "Rejected";
  return "Pending";
}

function getReviewStatusIcon(statusValue) {
  const normalized = normalizeReviewStatus(statusValue);
  if (normalized === "approved") return "✅";
  if (normalized === "rejected") return "❌";
  return "";
}

async function upsertSubmissionReviewStatus(recordId, slackId, reviewStatus) {
  await pool.query(
    `
      INSERT INTO submission_review_statuses (airtable_record_id, slack_user_id, review_status, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (airtable_record_id)
      DO UPDATE SET
        slack_user_id = EXCLUDED.slack_user_id,
        review_status = EXCLUDED.review_status,
        updated_at = CURRENT_TIMESTAMP
    `,
    [recordId, slackId || null, normalizeReviewStatus(reviewStatus)]
  );
}

async function getSubmissionReviewStatus(recordId) {
  const result = await pool.query(
    "SELECT review_status FROM submission_review_statuses WHERE airtable_record_id=$1 LIMIT 1",
    [recordId]
  );
  if (!result.rows.length) {
    return null;
  }
  return normalizeReviewStatus(result.rows[0].review_status);
}

async function getSubmissionNotificationState(recordId) {
  const result = await pool.query(
    "SELECT notification_sent, last_notified_review_status, last_notified_review_updated_at, last_notified_fingerprint FROM submission_notification_state WHERE airtable_record_id=$1 LIMIT 1",
    [recordId]
  );
  if (!result.rows.length) {
    return null;
  }
  return {
    notificationSent: Boolean(result.rows[0].notification_sent),
    lastNotifiedReviewStatus: normalizeReviewStatus(result.rows[0].last_notified_review_status),
    lastNotifiedReviewUpdatedAt: result.rows[0].last_notified_review_updated_at || null,
    lastNotifiedFingerprint: String(result.rows[0].last_notified_fingerprint || ""),
  };
}

async function upsertSubmissionNotificationState(recordId, fingerprint, reviewStatus, reviewUpdatedAt = null) {
  await pool.query(
    `
      INSERT INTO submission_notification_state (airtable_record_id, notification_sent, last_notified_review_status, last_notified_review_updated_at, last_notified_fingerprint, updated_at)
      VALUES ($1, TRUE, $2, $4, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (airtable_record_id)
      DO UPDATE SET
        notification_sent = TRUE,
        last_notified_review_status = EXCLUDED.last_notified_review_status,
        last_notified_review_updated_at = EXCLUDED.last_notified_review_updated_at,
        last_notified_fingerprint = EXCLUDED.last_notified_fingerprint,
        updated_at = CURRENT_TIMESTAMP
    `,
    [recordId, normalizeReviewStatus(reviewStatus), String(fingerprint || ""), reviewUpdatedAt]
  );
}

async function pollSubmissionReviewStatusChangesAndNotify() {
  const { rows } = await pool.query(`
    SELECT s.airtable_record_id, s.slack_user_id, s.review_status, s.updated_at AS review_updated_at, n.last_notified_review_status, n.last_notified_review_updated_at, n.notification_sent
    FROM submission_review_statuses s
    LEFT JOIN submission_notification_state n ON n.airtable_record_id = s.airtable_record_id
  `);

  for (const row of rows) {
    const currentStatus = normalizeReviewStatus(row.review_status);
    const lastNotifiedStatus = normalizeReviewStatus(row.last_notified_review_status);
    const reviewUpdatedAt = row.review_updated_at ? new Date(row.review_updated_at).getTime() : 0;
    const lastNotifiedUpdatedAt = row.last_notified_review_updated_at ? new Date(row.last_notified_review_updated_at).getTime() : 0;

    if (currentStatus === "pending") {
      continue;
    }

    if (lastNotifiedUpdatedAt && reviewUpdatedAt <= lastNotifiedUpdatedAt) {
      continue;
    }

    if (currentStatus === lastNotifiedStatus) {
      continue;
    }

    const slackId = normalizeSlackId(row.slack_user_id);
    if (!slackId) {
      continue;
    }

    const recordId = row.airtable_record_id;
    const baseMessageText = buildCustomMessage(
      { fields: {} },
      slackId,
      false,
      AIRTABLE_TABLE_NAME,
      AIRTABLE_DM_CUSTOM_MESSAGE_TEMPLATE,
    );
    const dmMessageText = `${baseMessageText}\n📌 *Review status:* ${getReviewStatusLabel(currentStatus)}`;

    await slack.client.chat.postMessage({
      channel: slackId,
      text: dmMessageText,
    });

    if (currentStatus === "approved" && AIRTABLE_NOTIFY_CHANNEL_ID) {
      await slack.client.chat.postMessage({
        channel: AIRTABLE_NOTIFY_CHANNEL_ID,
        text: AIRTABLE_APPROVED_CHANNEL_MESSAGE_TEMPLATE,
      });
    }

    await pool.query(
      `
        INSERT INTO submission_notification_state (airtable_record_id, notification_sent, last_notified_review_status, last_notified_review_updated_at, last_notified_fingerprint, updated_at)
        VALUES ($1, TRUE, $2, $3, COALESCE((SELECT last_notified_fingerprint FROM submission_notification_state WHERE airtable_record_id=$1), ''), CURRENT_TIMESTAMP)
        ON CONFLICT (airtable_record_id)
        DO UPDATE SET
          notification_sent = TRUE,
          last_notified_review_status = EXCLUDED.last_notified_review_status,
          last_notified_review_updated_at = EXCLUDED.last_notified_review_updated_at,
          updated_at = CURRENT_TIMESTAMP
      `,
      [recordId, currentStatus, row.review_updated_at]
    );
  }
}

function getFieldTextValue(fields = {}, fieldName = "") {
  const raw = fields[fieldName];

  if (raw === undefined || raw === null) {
    return "";
  }

  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join(", ");
  }

  if (typeof raw === "object") {
    return JSON.stringify(raw);
  }

  return String(raw).trim();
}

function getFirstTableReviewComment(fields = {}, reviewStatus = "rejected") {
  const normalizedReviewStatus = normalizeReviewStatus(reviewStatus);
  if (normalizedReviewStatus === "pending") {
    return "";
  }

  const selectedField = normalizedReviewStatus === "approved"
    ? AIRTABLE_APPROVAL_MESSAGE_FIELD
    : AIRTABLE_REJECTION_MESSAGE_FIELD;

  return getFieldTextValue(fields, selectedField);
}

function appendFirstTableReviewComment(messageText, fields = {}, reviewStatus = "rejected") {
  const normalizedReviewStatus = normalizeReviewStatus(reviewStatus);
  const reviewComment = getFirstTableReviewComment(fields, normalizedReviewStatus);
  if (!reviewComment) {
    return messageText;
  }

  const label = normalizedReviewStatus === "approved" ? "Acceptance comment" : "Rejection comment";
  return `${messageText}\n💬 *${label}:* ${reviewComment}`;
}

function appendApprovedChannelLinks(messageText, fields = {}) {
  const journalLink = getFieldTextValue(fields, AIRTABLE_JOURNAL_LINK_FIELD);
  const playableUrl = getFieldTextValue(fields, AIRTABLE_PLAYABLE_URL_FIELD);
  const tierValue = getFieldTextValue(fields, "Tier");
  const extras = [];

  if (tierValue) {
    extras.push(`🏷️ *Tier:* ${tierValue}`);
  }

  if (journalLink) {
    extras.push(`🔗 *Journal link:* ${journalLink}`);
  }

  if (playableUrl) {
    extras.push(`🧩 *Model URL:* ${playableUrl}`);
  }

  if (!extras.length) {
    return messageText;
  }

  return `${messageText}\n${extras.join("\n")}`;
}

async function sendMailStatusShippedDm(record) {
  const fields = record.fields || {};
  const slackId = normalizeSlackId(fields[AIRTABLE_SLACK_ID_FIELD]);
  if (!slackId) {
    console.warn(`Skipped mail-status update ${record.id}: missing Slack ID field '${AIRTABLE_SLACK_ID_FIELD}'.`);
    return;
  }

  const projectName = getFieldTextValue(fields, "Project Name") || "your project";
  const trackingLink = getFieldTextValue(fields, "Tracking Link");
  const trackingLine = trackingLink ? `\n🔎 Tracking: ${trackingLink}` : "";
  const messageText = `📦 ${projectName} has been shipped!${trackingLine}`;

  await slack.client.chat.postMessage({
    channel: slackId,
    text: messageText,
  });
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

function isGrantGranted(fields = {}) {
  const raw = fields[AIRTABLE_GRANT_FIELD];

  if (raw === undefined || raw === null) {
    return false;
  }

  if (Array.isArray(raw)) {
    return raw.some((value) => String(value).trim().toLowerCase() === AIRTABLE_GRANT_GRANTED_VALUE.toLowerCase());
  }

  return String(raw).trim().toLowerCase() === AIRTABLE_GRANT_GRANTED_VALUE.toLowerCase();
}

function didGrantChange(previousFields = {}, currentFields = {}) {
  return JSON.stringify(previousFields[AIRTABLE_GRANT_FIELD]) !== JSON.stringify(currentFields[AIRTABLE_GRANT_FIELD]);
}

async function sendGrantGrantedDm(record) {
  const fields = record.fields || {};
  const slackId = normalizeSlackId(fields[AIRTABLE_SLACK_ID_FIELD]);
  if (!slackId) {
    console.warn(`Skipped grant update ${record.id}: missing Slack ID field '${AIRTABLE_SLACK_ID_FIELD}'.`);
    return;
  }
  const mention = `<@${slackId}>`;
  const projectName = getFieldTextValue(fields, "Project Name");
  const tier = getFieldTextValue(fields, "Tier");
  const grantLink = getFieldTextValue(fields, AIRTABLE_GRANT_LINK_FIELD);

  const lines = [];
  // First line: mention + granted message
  lines.push(`${mention} your grant has been *Granted*!`);

  if (projectName) {
    lines.push(`• *Project Name:* ${projectName}`);
  }

  if (tier) {
    lines.push(`• *Tier:* ${tier}`);
  }

  if (grantLink) {
    lines.push(`🔗 *Grant link:* ${grantLink}`);
  }

  const messageText = lines.join("\n");

  await slack.client.chat.postMessage({
    channel: slackId,
    text: messageText,
    unfurl_links: false,
    unfurl_media: false,
  });
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

function shouldExcludeFieldKey(key, excludedFieldNames = []) {
  const normalized = String(key).trim().toLowerCase();
  return excludedFieldNames.some((fieldName) => String(fieldName).trim().toLowerCase() === normalized);
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
    excludedFieldNames = [],
    includeEntryLine = true,
  } = config;

  const fields = record.fields || {};
  const pickedKeys = notifyFields.length
    ? notifyFields
    : Object.keys(fields).slice(0, 5);

  const safeKeys = pickedKeys.filter((key) => !shouldHideFieldKey(key) && !shouldExcludeFieldKey(key, excludedFieldNames));

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

  const outputLines = [customMessage];
  if (includeEntryLine) {
    outputLines.push(`${emoji} *${status}* entry in *${tableName}*`);
  }
  outputLines.push(...lines);

  return outputLines.join("\n");
}

async function fetchAirtableRecords(tableName) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}?pageSize=100`;
  try {
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
  } catch (err) {
    console.error('Airtable fetch failed (full error):', err);
    throw err;
  }
}

async function sendFirstTableNotification(record, options = {}) {
  const { forceDmOnly = false } = options;
  const fields = record.fields || {};
  const slackId = normalizeSlackId(fields[AIRTABLE_SLACK_ID_FIELD]);
  
  if (!slackId) {
    console.warn(`Skipped Airtable update ${record.id}: missing Slack ID field '${AIRTABLE_SLACK_ID_FIELD}'.`);
    return;
  }

  const derivedStatus = getReviewStatusFromRecord(record);
  if (derivedStatus === "pending") {
    return;
  }

  await upsertSubmissionReviewStatus(record.id, slackId, derivedStatus);
  const dbReviewStatus = (await getSubmissionReviewStatus(record.id)) || derivedStatus;

  const statusLabel = getReviewStatusLabel(dbReviewStatus);
  const statusIcon = getReviewStatusIcon(dbReviewStatus);
  const dmBaseMessageTemplate = `{mention} your project {Project Name} has been ${statusLabel.toLowerCase()} for {Tier}. ${statusIcon}`.trim();

  const dmBaseMessageText = formatAirtableRecord(record, slackId, false, {
    tableName: AIRTABLE_TABLE_NAME,
    notifyFields: AIRTABLE_NOTIFY_FIELDS,
    messageTemplate: dmBaseMessageTemplate,
    excludedFieldNames: ["Name", "Status", AIRTABLE_MAIL_STATUS_FIELD],
    includeEntryLine: false,
  });
  const dmMessageText = appendFirstTableReviewComment(dmBaseMessageText, fields, dbReviewStatus);

  const approvedChannelBaseMessageText = buildCustomMessage(
    record,
    slackId,
    false,
    AIRTABLE_TABLE_NAME,
    AIRTABLE_APPROVED_CHANNEL_MESSAGE_TEMPLATE,
  );
  const approvedChannelMessageText = appendApprovedChannelLinks(approvedChannelBaseMessageText, fields);

  const isApproved = normalizeReviewStatus(dbReviewStatus) === "approved";

  if (forceDmOnly) {
    await slack.client.chat.postMessage({
      channel: slackId,
      text: dmMessageText,
    });
    return;
  }

  if (isApproved) {
    // Approved: send DM and post to channel.
    await slack.client.chat.postMessage({
      channel: slackId,
      text: dmMessageText,
    });

    if (AIRTABLE_NOTIFY_CHANNEL_ID) {
      await slack.client.chat.postMessage({
        channel: AIRTABLE_NOTIFY_CHANNEL_ID,
        text: approvedChannelMessageText,
      });
    }
  } else {
    // Not approved: send DM only
    await slack.client.chat.postMessage({
      channel: slackId,
      text: dmMessageText,
    });
  }

  await upsertSubmissionNotificationState(record.id, getRecordFingerprint(record), dbReviewStatus, new Date().toISOString());
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
    for (const record of records) {
      const fingerprint = getRecordFingerprint(record);
      seenAirtableRecords.set(record.id, {
        fingerprint,
        fields: record.fields || {},
      });
    }
    airtableInitialized = true;
    console.log(`Airtable watcher initialized with ${records.length} existing records.`);
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
    const currentReviewStatus = getReviewStatusFromRecord(record);
    const previousReviewStatus = getReviewStatusFromFields(previousFields);
    const reviewStatus = currentReviewStatus;

    const shippedNow = isMailStatusShipped(record.fields || {});
    const shippedBefore = isMailStatusShipped(previousFields);
    if (shippedNow && !shippedBefore) {
      console.log(`Airtable record ${record.id} mail status changed to '${AIRTABLE_MAIL_STATUS_SHIPPED_VALUE}'. Sending Slack DM.`);
      await sendMailStatusShippedDm(record);
    }

    // Grant field changed to Granted -> notify user
    const grantNow = isGrantGranted(record.fields || {});
    const grantBefore = isGrantGranted(previousFields || {});
    if (grantNow && !grantBefore) {
      console.log(`Airtable record ${record.id} grant field changed to '${AIRTABLE_GRANT_GRANTED_VALUE}'. Sending Slack DM.`);
      try {
        await sendGrantGrantedDm(record);
      } catch (err) {
        console.error(`Failed to send grant notification for ${record.id}:`, err && err.message ? err.message : err);
      }
    }

    if (reviewStatus === "pending") {
      continue;
    }

    if (currentReviewStatus === previousReviewStatus) {
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

slack.event("app_mention", async ({ event }) => {
  await maybeReplyGreeting(event);
});

slack.event("message", async ({ event }) => {
  const didReplyGreeting = await maybeReplyGreeting(event);
  if (didReplyGreeting && event.channel_type !== "im") {
    return;
  }

  const text = (event.text || "").trim();
  if (!text) return;

  if (event.subtype || event.bot_id) return;

  if (event.channel_type !== "im") return;

  const slackId = event.user;

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
  await ensureSubmissionReviewStatusesTable();
  await ensureSubmissionNotificationStateTable();
  await seedSubmissionNotificationStateFromReviewStatuses();
  await slack.start(Number(process.env.PORT || 3000));
  console.log("Slack Bolt running on port", process.env.PORT || 3000);
  console.log("🌐 Dashboard running on port", process.env.PORT || 3000);

  setInterval(async () => {
    try {
      await Promise.all([
        pollAirtableAndNotify(),
        pollSubmissionReviewStatusChangesAndNotify(),
        pollSecondAirtableAndNotify(),
      ]);
    } catch (error) {
      console.error("Airtable poll failed:", error.message);
    }
  }, AIRTABLE_POLL_INTERVAL_MS);

})();
