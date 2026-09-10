-- Matches the table contract shipped with connect-pg-simple 10.0.0.
-- The package's obsolete WITH (OIDS=FALSE) storage clause is intentionally omitted
-- because PostgreSQL 16 no longer supports table OIDs.
CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

ALTER TABLE "session"
  ADD CONSTRAINT "session_pkey"
  PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");
