-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    slack_id TEXT UNIQUE NOT NULL
);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    slack_user_id TEXT NOT NULL REFERENCES users(slack_id),
    status TEXT DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender TEXT NOT NULL, -- 'user' or 'admin'
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Blocked users table
CREATE TABLE IF NOT EXISTS blocked_users (
    slack_user_id TEXT PRIMARY KEY REFERENCES users(slack_id),
    blocked_by TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Airtable submission review status cache
CREATE TABLE IF NOT EXISTS submission_review_statuses (
    airtable_record_id TEXT PRIMARY KEY,
    slack_user_id TEXT,
    review_status TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION set_submission_review_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS submission_review_statuses_updated_at ON submission_review_statuses;

CREATE TRIGGER submission_review_statuses_updated_at
BEFORE UPDATE ON submission_review_statuses
FOR EACH ROW
EXECUTE FUNCTION set_submission_review_status_updated_at();

-- Airtable notification dedupe cache
CREATE TABLE IF NOT EXISTS submission_notification_state (
    airtable_record_id TEXT PRIMARY KEY,
    notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
    last_notified_review_status TEXT,
    last_notified_review_updated_at TIMESTAMP,
    last_notified_fingerprint TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);