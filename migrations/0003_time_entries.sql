CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  description TEXT,
  entry_date TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  stripe_invoice_item_id TEXT,
  stripe_invoice_id TEXT,
  pushed_at INTEGER,
  billed_at INTEGER,
  voided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_entries_customer_status ON time_entries (customer_id, status);
CREATE INDEX IF NOT EXISTS idx_time_entries_status ON time_entries (status);
CREATE INDEX IF NOT EXISTS idx_time_entries_stripe_invoice_item ON time_entries (stripe_invoice_item_id);
