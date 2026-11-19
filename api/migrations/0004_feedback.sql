-- Feedback form (/feedback/, POST /api/v1/feedback). Kept 1 year: every insert deletes rows older than that (the
-- privacy policy states the period). No IP address or user agent is stored. user_id is the logged-in account, if
-- any (no foreign key: deleting the account sets it to NULL). email_status records the notification mail; the row
-- is written before the mail is sent, so a failed send loses nothing.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'request', 'data', 'other')),
  message TEXT NOT NULL,
  reply_to TEXT,
  page TEXT,
  user_id TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed')),
  email_error TEXT
) WITHOUT ROWID;
CREATE INDEX idx_feedback_created ON feedback (created_at);
CREATE INDEX idx_feedback_user ON feedback (user_id) WHERE user_id IS NOT NULL;
