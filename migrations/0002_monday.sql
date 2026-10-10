ALTER TABLE verdicts ADD COLUMN model TEXT;
ALTER TABLE verdicts ADD COLUMN deterministic_evidence REAL;
ALTER TABLE verdicts ADD COLUMN error TEXT;
ALTER TABLE holds ADD COLUMN token_hash TEXT;
ALTER TABLE holds ADD COLUMN token_plain TEXT;
ALTER TABLE holds ADD COLUMN resolved_at TEXT;
