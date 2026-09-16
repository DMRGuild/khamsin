CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL CHECK (collection IN ('allowlist','admins','tags','custom','pins','meta')),
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (collection, key)
);
-- Adding a role always grants access, including imports and bootstrap.
CREATE TRIGGER IF NOT EXISTS admin_grants_access AFTER INSERT ON records
WHEN NEW.collection = 'admins'
BEGIN
  INSERT OR IGNORE INTO records(collection,key,value) VALUES ('allowlist',NEW.key,'');
END;
-- Only Nostr authentication is implemented; preserve a usable administrator.
CREATE TRIGGER IF NOT EXISTS protect_last_admin BEFORE DELETE ON records
WHEN OLD.collection = 'admins' AND length(OLD.key) = 64
 AND OLD.key NOT GLOB '*[^0-9a-f]*'
 AND (SELECT count(*) FROM records WHERE collection='admins'
      AND length(key)=64 AND key NOT GLOB '*[^0-9a-f]*') <= 1
BEGIN SELECT RAISE(ABORT, 'Cannot remove the last Nostr administrator'); END;
CREATE TRIGGER IF NOT EXISTS revoke_admin AFTER DELETE ON records
WHEN OLD.collection = 'allowlist'
BEGIN DELETE FROM records WHERE collection='admins' AND key=OLD.key; END;
CREATE TABLE IF NOT EXISTS store_revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO store_revision VALUES (1,0);
CREATE TRIGGER IF NOT EXISTS record_insert AFTER INSERT ON records
BEGIN UPDATE store_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS record_update AFTER UPDATE ON records
BEGIN UPDATE store_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS record_delete AFTER DELETE ON records
BEGIN UPDATE store_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mark_initialized AFTER INSERT ON records
WHEN NEW.collection = 'admins'
BEGIN INSERT OR IGNORE INTO records(collection,key,value) VALUES ('meta','initialized','1'); END;
