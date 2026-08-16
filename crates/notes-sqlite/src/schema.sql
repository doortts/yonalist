BEGIN IMMEDIATE;
CREATE TABLE notes_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
INSERT INTO notes_meta(singleton, revision) VALUES (1, 0);

CREATE TABLE notes_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT,
    sort_key INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'bullet', 'image')),
    text TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    marker TEXT NOT NULL DEFAULT 'bullet'
        CHECK (marker IN ('bullet', 'todo', 'ordered')),
    -- Only an `ordered` row reads this; every other marker leaves
    -- it at the default rather than carrying a number nobody draws.
    ordered_start INTEGER NOT NULL DEFAULT 1,
    collapsed INTEGER NOT NULL DEFAULT 0
        CHECK (collapsed IN (0, 1)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    path TEXT,
    -- Stamped by trigger, not by the mutation code: that is what
    -- lets every existing command path carry a clock reading
    -- without one of them being rewritten.
    hlc TEXT NOT NULL DEFAULT '',
    -- Which sibling this node's last accepted move said it follows. The
    -- order two devices reach has to be the same whichever file each read
    -- first, and that is only possible if the claim outlives the merge that
    -- accepted it: without it, the answer depends on when a neighbour
    -- happened to be restamped. Empty means "first among siblings".
    sync_prev TEXT NOT NULL DEFAULT '',
    -- When that claim was made. Deliberately not the row's own stamp: a text
    -- edit restamps the row, and sharing the two would promote a stale claim
    -- into the newest ordering layer — an edit would read as a move. Empty
    -- means no merge has written one yet, and the claim is derived from where
    -- the row currently sits.
    sync_prev_hlc TEXT NOT NULL DEFAULT '',
    -- Whatever the parser met in the file and had no field for,
    -- carried back out unchanged so a newer app's values survive
    -- a round trip through this one.
    sync_extras TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(parent_id) REFERENCES notes_nodes(id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (kind = 'page' AND parent_id IS NULL) OR
        (kind IN ('bullet', 'image') AND parent_id IS NOT NULL)
    )
) STRICT;
CREATE INDEX notes_nodes_parent_order
    ON notes_nodes(parent_id, deleted, sort_key, id);
CREATE INDEX notes_nodes_path ON notes_nodes(path);

CREATE TABLE notes_images (
    node_id TEXT PRIMARY KEY NOT NULL,
    -- Empty means the metadata arrived before the bytes did: a file can
    -- state an image's size and name while its asset is still in flight,
    -- and the node has to apply anyway or the line cannot be re-rendered.
    content_hash TEXT NOT NULL CHECK (
        content_hash = '' OR (
            length(content_hash) = 64 AND
            content_hash NOT GLOB '*[^0-9a-f]*'
        )
    ),
    relative_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (
        mime_type IN (
            'image/png', 'image/jpeg', 'image/gif', 'image/webp'
        )
    ),
    byte_length INTEGER NOT NULL
        CHECK (byte_length BETWEEN 1 AND 20971520),
    pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
    pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
    display_width INTEGER NOT NULL CHECK (display_width >= 120),
    FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
) STRICT;

CREATE VIEW notes_node_records AS
SELECT
    node.id,
    node.parent_id,
    node.sort_key,
    node.kind,
    node.text,
    node.note,
    node.marker,
    node.collapsed,
    node.completed,
    node.starred,
    node.deleted,
    image.content_hash,
    image.relative_path,
    image.original_name,
    image.mime_type,
    image.byte_length,
    image.pixel_width,
    image.pixel_height,
    image.display_width,
    -- Last, so the image columns above keep the positions the row
    -- mapping reads them at.
    node.ordered_start
FROM notes_nodes node
LEFT JOIN notes_images image ON image.node_id = node.id;

CREATE TABLE notes_tags (
    node_id TEXT NOT NULL,
    token TEXT NOT NULL,
    display_tag TEXT NOT NULL,
    PRIMARY KEY(node_id, token),
    FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX notes_tags_token ON notes_tags(token, node_id);

CREATE TABLE notes_dates (
    node_id TEXT NOT NULL,
    date_key TEXT NOT NULL,
    PRIMARY KEY(node_id, date_key),
    FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX notes_dates_key ON notes_dates(date_key, node_id);

CREATE VIRTUAL TABLE notes_fts USING fts5(
    node_id UNINDEXED,
    text,
    note,
    tokenize = 'unicode61'
);
-- The three stamping triggers. They fire only when the row
-- arrives without a reading of its own, so a merge that carries one
-- from another device keeps it (spec invariant 6).
CREATE TRIGGER notes_nodes_hlc_ai AFTER INSERT ON notes_nodes
WHEN NEW.hlc = ''
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  VALUES (NEW.id, unixepoch())
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
  -- The file that holds this line states it, so it owes a write too.
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  SELECT NEW.parent_id, unixepoch() WHERE NEW.parent_id IS NOT NULL
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

-- Named columns, not the whole row: `path` is derived, and a move
-- rewrites it across the whole subtree. A blanket AFTER UPDATE would
-- restamp every untouched descendant, and that reading would then
-- beat a real edit made on another device.
CREATE TRIGGER notes_nodes_hlc_au AFTER UPDATE OF
    parent_id, sort_key, kind, text, note, marker, ordered_start,
    collapsed, completed, starred, deleted, sync_extras
ON notes_nodes
-- A write that leaves every stamped column as it was is not an edit, whoever
-- made it. Stamping it anyway would hand this device a reading it did not
-- earn, and that reading then beats a real edit made elsewhere. `IS NOT`
-- rather than `<>` so a column that is null on both sides counts as unchanged.
WHEN NEW.hlc = OLD.hlc AND (
       NEW.parent_id IS NOT OLD.parent_id
    OR NEW.sort_key IS NOT OLD.sort_key
    OR NEW.kind IS NOT OLD.kind
    OR NEW.text IS NOT OLD.text
    OR NEW.note IS NOT OLD.note
    OR NEW.marker IS NOT OLD.marker
    OR NEW.ordered_start IS NOT OLD.ordered_start
    OR NEW.collapsed IS NOT OLD.collapsed
    OR NEW.completed IS NOT OLD.completed
    OR NEW.starred IS NOT OLD.starred
    OR NEW.deleted IS NOT OLD.deleted
    OR NEW.sync_extras IS NOT OLD.sync_extras
)
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  VALUES (NEW.id, unixepoch())
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
  -- Both ends of a move: the file it left still states the line, and the
  -- file it arrived in does not state it yet.
  -- Aliased and qualified on both sides: a bare `id` in the EXISTS would
  -- resolve to `notes_nodes.id` and compare the row with itself, which is
  -- true for every row and filters nothing.
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  SELECT ends.id, unixepoch() FROM (
      SELECT NEW.parent_id AS id UNION SELECT OLD.parent_id
  ) AS ends WHERE ends.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM notes_nodes WHERE notes_nodes.id = ends.id
  )
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

-- Where a line sits is stated in the file beside it, so a claim changing is
-- a change to the file. It is not a change to the node — which is why these
-- columns are deliberately absent from the stamping trigger above, and why
-- this one only marks.
CREATE TRIGGER notes_nodes_place_au AFTER UPDATE OF sync_prev, sync_prev_hlc
ON notes_nodes
WHEN NEW.sync_prev IS NOT OLD.sync_prev OR NEW.sync_prev_hlc IS NOT OLD.sync_prev_hlc
BEGIN
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  VALUES (NEW.id, unixepoch())
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

-- A hard delete is undo taking back a create, or a cascade following one.
-- The row is gone, so nothing can ever work out which file owed it a write:
-- its mark would sit in the queue for good, and a queue that never empties
-- blocks the reindex that reads the vault as the truth. What is owed is the
-- rewrite of the file that still states the line, which is the parent's.
CREATE TRIGGER notes_nodes_hlc_ad AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM sync_dirty_nodes WHERE node_id = OLD.id;
  INSERT INTO sync_dirty_nodes(node_id, marked_at)
  SELECT OLD.parent_id, unixepoch()
  WHERE OLD.parent_id IS NOT NULL AND EXISTS (
      -- `OLD.parent_id` is unambiguous here, unlike the update trigger's
      -- derived column: it names the row that left, not a column of the
      -- table being searched.
      SELECT 1 FROM notes_nodes WHERE notes_nodes.id = OLD.parent_id
  )
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes_nodes BEGIN
    INSERT INTO notes_fts(node_id, text, note)
    VALUES (new.id, new.text, new.note);
END;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF text, note ON notes_nodes BEGIN
    DELETE FROM notes_fts WHERE node_id = old.id;
    INSERT INTO notes_fts(node_id, text, note)
    VALUES (new.id, new.text, new.note);
END;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes_nodes BEGIN
    DELETE FROM notes_fts WHERE node_id = old.id;
END;

CREATE TABLE sync_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id TEXT NOT NULL,
    vault_uuid TEXT NOT NULL
) STRICT;

-- One row per document. Page, home and split documents are the
-- same thing here.
CREATE TABLE sync_documents (
    root_id TEXT PRIMARY KEY NOT NULL,
    folder_path TEXT NOT NULL UNIQUE,
    applied_max_hlc TEXT NOT NULL DEFAULT '',
    exported_hash TEXT NOT NULL DEFAULT '',
    file_mtime_ms INTEGER,
    file_size INTEGER,
    quarantined INTEGER NOT NULL DEFAULT 0
        CHECK (quarantined IN (0, 1))
) STRICT;

CREATE TABLE sync_dirty_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,
    marked_at INTEGER NOT NULL DEFAULT 0
) STRICT;

-- What each node looked like when it last went out, so an edit that
-- returns a value to where it was does not advance its clock and
-- does not rewrite the file.
CREATE TABLE sync_node_exports (
    node_id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL,
    exported_hlc TEXT NOT NULL
) STRICT;

CREATE TABLE sync_conflict_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    loser_json TEXT NOT NULL,
    loser_hlc TEXT NOT NULL,
    winner_hlc TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
) STRICT;

-- Where an attachment's bytes currently sit, and when it stopped
-- being referenced. The reference count itself is not stored: it is
-- counted off the nodes, so it cannot drift into deleting a file
-- something still points at.
CREATE TABLE sync_assets (
    content_hash TEXT PRIMARY KEY NOT NULL,
    disk_name TEXT NOT NULL,
    location TEXT NOT NULL,
    unreferenced_at INTEGER
) STRICT;

CREATE TABLE notes_ui_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

PRAGMA user_version = 1;
COMMIT;
