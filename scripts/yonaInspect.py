#!/usr/bin/env python3
"""Read Yonalist's own state from outside the app.

The database and the vault are the only record the app keeps, so this reads
both and puts them side by side. Everything here is read-only: the sqlite
files are copied to a temporary directory first, so a running app is never
locked and never sees a second writer.

    scripts/yonaInspect.py doctor          # the checks worth running first
    scripts/yonaInspect.py pages           # title in the database vs in the vault
    scripts/yonaInspect.py node rDibyYosWVJY
    scripts/yonaInspect.py timeline --since 17:00
    scripts/yonaInspect.py instances       # who else writes this vault
    scripts/yonaInspect.py device          # is this machine's id stable?
    scripts/yonaInspect.py conflicts
    scripts/yonaInspect.py hlc 0mt196sb0-00-52e4
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import datetime as dt
import json
import hashlib
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import tempfile
import unicodedata

SUPPORT = pathlib.Path.home() / "Library" / "Application Support"
DEFAULT_DATA_DIR = SUPPORT / "com.doortts.yonalist.v2"
DB_NAME = "notes-v2.sqlite"
BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


# --- hybrid logical clocks ---------------------------------------------------
# `crates/notes-sync/src/hlc.rs`: nine base36 characters of milliseconds, two of
# a counter, four of a device id, joined by hyphens. String order is time order,
# which is why nothing in the app ever decodes them -- and why reading the state
# by hand is impossible without this.


def hlc_parts(stamp: str) -> tuple[int, int, str] | None:
    if len(stamp) != 17 or stamp[9] != "-" or stamp[12] != "-":
        return None
    try:
        millis = int(stamp[:9], 36)
        counter = int(stamp[10:12], 36)
    except ValueError:
        return None
    return millis, counter, stamp[13:]


def hlc_time(stamp: str) -> dt.datetime | None:
    parts = hlc_parts(stamp)
    if parts is None:
        return None
    return dt.datetime.fromtimestamp(parts[0] / 1000)


def show_hlc(stamp: str) -> str:
    parts = hlc_parts(stamp)
    if parts is None:
        return f"{stamp or '(none)':<17}  --"
    when = dt.datetime.fromtimestamp(parts[0] / 1000)
    return f"{stamp:<17}  {when:%Y-%m-%d %H:%M:%S}.{when.microsecond // 1000:03d}  c={parts[1]}  device={parts[2]}"


def unescape_inline(value: str) -> str:
    """Undo `render.rs`'s `escape_markdown`, enough to compare titles.

    Order matters: `&amp;` has to come back before anything else, or a title
    holding a literal `&amp;` would be unescaped twice.
    """
    out = []
    index = 0
    while index < len(value):
        if value.startswith("&amp;", index):
            out.append("&")
            index += 5
        elif value.startswith("&lt;", index):
            out.append("<")
            index += 4
        elif value.startswith("\\n", index):
            out.append("\n")
            index += 2
        elif value[index] == "\\" and index + 1 < len(value):
            out.append(value[index + 1])
            index += 2
        else:
            out.append(value[index])
            index += 1
    return "".join(out)


def machine_seed() -> bytes | None:
    """The sixteen bytes `gethostuuid(2)` gives, which is `IOPlatformUUID`.

    Same call `crates/notes-sync/src/hlc.rs` makes, so this answers "what would
    this machine provision" without building the app. Measured to survive the
    App Sandbox and the hardened runtime, so a failure here is a real failure
    rather than a signing artefact.
    """
    if sys.platform != "darwin":
        return None

    class Timespec(ctypes.Structure):
        _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]

    libc = ctypes.CDLL(ctypes.util.find_library("c"))
    buffer = (ctypes.c_ubyte * 16)()
    if libc.gethostuuid(buffer, ctypes.byref(Timespec(5, 0))) != 0:
        return None
    return bytes(buffer)


DEVICE_WIDTH = 8


def derived_device_id(seed: bytes, scope: str, width: int = DEVICE_WIDTH) -> str:
    """What `hlc.rs::device_seed` would provision here.

    The scope is the database's own place. It is part of the input because the id
    names a *writer*, not a machine: two databases on one Mac are two writers, and
    a shared id has the merge read one's files as the other's own authoring.
    """
    digest = hashlib.sha256()
    digest.update(seed)
    digest.update(b"\x00")
    digest.update(scope.encode("utf-8"))
    return digest.hexdigest()[:width]


def show_ms(millis: int | None) -> str:
    if millis is None:
        return "--"
    when = dt.datetime.fromtimestamp(millis / 1000)
    return f"{when:%Y-%m-%d %H:%M:%S}.{when.microsecond // 1000:03d}"



STAMP_KEYS = ("max_hlc", "root_hlc", "stated_max_hlc")
NARROW = re.compile(r"(?<![0-9a-z])([0-9a-z]{9}-[0-9a-z]{2}-)([0-9a-f]{4})(?![0-9a-f])")


def widen_stamp_line(line: str) -> str:
    """One vault line with its readings widened from four device characters to
    eight, by appending zeroes.

    Zeroes rather than the machine's own id: a stamp this device wrote before the
    widening must not come back as one it wrote after. `mine` in the merge adopts
    a file's content over the row's on a device match and records nothing, so the
    safe direction is for old readings to read as another device's and take the
    logged path.

    Every id is padded the same way, so the order the old readings were in
    survives -- the device field only breaks ties inside one millisecond.
    """
    key, separator, value = line.partition(": ")
    if separator and key in STAMP_KEYS:
        return key + separator + NARROW.sub(lambda m: m.group(1) + m.group(2) + "0000", value)
    if separator and key == "device_id":
        stripped = value.strip()
        if len(stripped) == 4 and all(character in "0123456789abcdef" for character in stripped):
            return f"{key}: {stripped}0000"
        return line
    # A footer token line, or an id comment carrying one. `t:` and `prev:` both
    # hold readings, and both live inside the yonalist comment block.
    if "t: " in line or "prev: " in line:
        return NARROW.sub(lambda m: m.group(1) + m.group(2) + "0000", line)
    return line


# --- the two sources ---------------------------------------------------------


class State:
    """A snapshot: the copied database plus whatever the vault says."""

    def __init__(self, data_dir: pathlib.Path, needs_db: bool = True) -> None:
        self.data_dir = data_dir
        self._temp = tempfile.mkdtemp(prefix="yona-inspect-")
        live = data_dir / DB_NAME
        # A repair on the vault has to work when there is no database -- that is
        # the state the repair exists for.
        if not live.is_file():
            if needs_db:
                raise SystemExit(f"No database at {live}")
            self.db = None
            self.vault = self._vault_path()
            return
        copy = pathlib.Path(self._temp) / DB_NAME
        # The write-ahead log holds everything written since the last
        # checkpoint, so a copy without it reads minutes or hours stale.
        for suffix in ("", "-wal", "-shm"):
            source = pathlib.Path(str(live) + suffix)
            if source.is_file():
                shutil.copy2(source, str(copy) + suffix)
        self.db = sqlite3.connect(str(copy))
        self.db.row_factory = sqlite3.Row
        self.vault = self._vault_path()

    def _vault_path(self) -> pathlib.Path | None:
        marker = self.data_dir / "vault-path"
        if not marker.is_file():
            return None
        return pathlib.Path(marker.read_text(encoding="utf-8").strip())

    def rows(self, sql: str, *args) -> list[sqlite3.Row]:
        return list(self.db.execute(sql, args))

    def one(self, sql: str, *args):
        row = self.db.execute(sql, args).fetchone()
        return row[0] if row else None

    def database_scope(self) -> str:
        """What `device_scope` in the worker builds: the database's own place,
        resolved and NFC-normalised, so the same file reached two ways is one
        writer and two spellings of one Korean folder name are too."""
        live = self.data_dir / DB_NAME
        parent = live.parent
        try:
            parent = parent.resolve(strict=True)
        except OSError:
            pass
        return unicodedata.normalize("NFC", str(parent / live.name))

    def device_id(self) -> str:
        return self.one("SELECT device_id FROM sync_meta WHERE singleton = 1") or "?"

    def file_of(self, relative: str) -> dict | None:
        """What a vault document states about itself."""
        if self.vault is None:
            return None
        path = self.vault / relative
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        lines = text.split("\n")
        if not lines or lines[0].strip() != "---":
            return None
        keys: dict[str, str] = {}
        body_at = len(lines)
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                body_at = index + 1
                break
            key, _, value = lines[index].partition(":")
            keys[key.strip()] = value.strip()
        body = lines[body_at:]
        heading = body[0] if body else ""
        title = (
            unescape_inline(heading[2:])
            if heading.startswith("# ")
            else ("" if heading.strip() == "#" else None)
        )
        links = []
        for line in body:
            stripped = line.strip()
            if stripped.startswith("- [") and "](" in stripped:
                label = unescape_inline(stripped[3 : stripped.index("](")])
                yid = stripped.rsplit("yid:", 1)[-1].strip(" ->") if "yid:" in stripped else ""
                links.append((yid, label))
        return {
            "path": path,
            "keys": keys,
            "title": title,
            "links": links,
            "mtime_ms": int(path.stat().st_mtime * 1000),
        }


# --- commands ----------------------------------------------------------------


def command_instances(state: State, _args) -> int:
    """Every app instance on this machine, and which vault each one writes."""
    print(f"this instance   {state.data_dir}")
    print(f"  device_id     {state.device_id()}")
    print(f"  vault         {state.vault}")
    print(f"  vault_uuid    {state.one('SELECT vault_uuid FROM sync_meta WHERE singleton = 1')}")
    print()
    print("device ids this vault has seen (sync_devices):")
    for row in state.rows("SELECT device_id, name FROM sync_devices ORDER BY device_id"):
        here = "  <- this instance" if row["device_id"] == state.device_id() else ""
        print(f"  {row['device_id']}  {row['name']}{here}")
    print()
    print("other data directories on this machine:")
    for directory in sorted(SUPPORT.glob("com.doortts.yonalist*")):
        if directory == state.data_dir or not (directory / DB_NAME).is_file():
            continue
        marker = directory / "vault-path"
        vault = marker.read_text(encoding="utf-8").strip() if marker.is_file() else "(no vault)"
        shared = "  SHARES THIS VAULT" if state.vault and vault == str(state.vault) else ""
        stamp = show_ms(int((directory / DB_NAME).stat().st_mtime * 1000))
        print(f"  {directory.name}")
        print(f"    last written {stamp}   vault {vault}{shared}")
    return 0


def page_report(state: State) -> list[dict]:
    home = state.file_of("README.md") or {"links": []}
    labels = dict(home.get("links", []))
    report = []
    for row in state.rows(
        """SELECT n.id, n.text, n.hlc, n.deleted, d.folder_path, d.applied_max_hlc,
                  e.exported_hlc
           FROM notes_nodes n
           LEFT JOIN sync_documents d ON d.root_id = n.id
           LEFT JOIN sync_node_exports e ON e.node_id = n.id
           WHERE n.parent_id = 'root' AND n.deleted = 0
           ORDER BY n.sort_key"""
    ):
        folder = row["folder_path"]
        document = state.file_of(folder) if folder else None
        report.append(
            {
                "id": row["id"],
                "row_title": row["text"],
                "row_hlc": row["hlc"],
                "folder": folder,
                "home_label": labels.get(row["id"]),
                "file_title": document["title"] if document else None,
                "file_root_hlc": (document or {}).get("keys", {}).get("root_hlc"),
                "file_writer": (document or {}).get("keys", {}).get("device_id"),
                "file_mtime_ms": (document or {}).get("mtime_ms"),
                "applied_max_hlc": row["applied_max_hlc"],
                "exported_hlc": row["exported_hlc"],
            }
        )
    return report


def command_pages(state: State, _args) -> int:
    for page in page_report(state):
        print(f"{page['id']}")
        print(f"  database        {page['row_title']!r}   {show_hlc(page['row_hlc'] or '')}")
        print(f"  home README     {page['home_label']!r}")
        print(f"  page file       {page['file_title']!r}   root_hlc {page['file_root_hlc']}")
        print(f"  folder          {page['folder']}")
        print(f"  written by      {page['file_writer']}   at {show_ms(page['file_mtime_ms'])}")
        print(f"  applied/export  {page['applied_max_hlc']}  /  {page['exported_hlc']}")
        print()
    return 0


def command_node(state: State, args) -> int:
    row = state.db.execute("SELECT * FROM notes_nodes WHERE id = ?", (args.id,)).fetchone()
    if row is None:
        print(f"No node {args.id}")
        return 1
    for key in row.keys():
        value = row[key]
        if key in ("hlc", "sync_prev_hlc") and value:
            print(f"  {key:<16} {show_hlc(value)}")
        else:
            print(f"  {key:<16} {value!r}")
    export = state.db.execute(
        "SELECT * FROM sync_node_exports WHERE node_id = ?", (args.id,)
    ).fetchone()
    print("\n  last written out:")
    if export is None:
        print("    (never)")
    else:
        print(f"    content_hash   {export['content_hash']}")
        print(f"    exported_hlc   {show_hlc(export['exported_hlc'])}")
        if export["exported_hlc"] != row["hlc"]:
            print("    NOTE the row's stamp differs from the one last written out")
    document = state.db.execute(
        "SELECT * FROM sync_documents WHERE root_id = ?", (args.id,)
    ).fetchone()
    if document is not None:
        print("\n  its document:")
        for key in document.keys():
            print(f"    {key:<16} {document[key]!r}")
    dirty = state.one("SELECT marked_at FROM sync_dirty_nodes WHERE node_id = ?", args.id)
    print(f"\n  owes a write: {'yes, marked ' + show_ms(dirty * 1000) if dirty else 'no'}")
    conflicts = state.rows(
        "SELECT * FROM sync_conflict_log WHERE node_id = ? ORDER BY seq", args.id
    )
    print(f"\n  recorded conflicts: {len(conflicts)}")
    for conflict in conflicts:
        print(f"    seq {conflict['seq']} at {show_ms(conflict['recorded_at'] * 1000)}")
        print(f"      lost {conflict['loser_json']}")
        print(f"      kept {conflict['winner_json']}")
    return 0


def command_timeline(state: State, args) -> int:
    """Every time the state holds, in order.

    The app keeps no event log, so this is as close as the record gets, and the
    two kinds of line must not be read as one. `[stamp]` is when a reading was
    *minted* -- the edit it stands for happened then, but the merge or export
    that later carried it could have run at any time after. `[clock]` is a real
    wall-clock event: a file's mtime, a conflict being recorded.
    """
    events: list[tuple[dt.datetime, str]] = []

    def add(stamp: str | None, what: str) -> None:
        when = hlc_time(stamp) if stamp else None
        if when is not None:
            events.append((when, f"[stamp] {what:<44} {stamp}"))

    def add_clock(millis: int, what: str) -> None:
        events.append((dt.datetime.fromtimestamp(millis / 1000), f"[clock] {what}"))

    for row in state.rows("SELECT id, text, hlc, deleted FROM notes_nodes"):
        mark = " (deleted)" if row["deleted"] else ""
        add(row["hlc"], f"row now reads {row['id']}{mark} {row['text'][:24]!r}")
    for row in state.rows("SELECT node_id, exported_hlc FROM sync_node_exports"):
        add(row["exported_hlc"], f"reading recorded at export {row['node_id']}")
    for row in state.rows("SELECT root_id, applied_max_hlc FROM sync_documents"):
        add(
            row["applied_max_hlc"],
            f"high-water mark of last file merged into {row['root_id']}",
        )
    for row in state.rows("SELECT root_id, file_mtime_ms FROM sync_documents"):
        if row["file_mtime_ms"]:
            add_clock(row["file_mtime_ms"], f"file of {row['root_id']} last written")
    for row in state.rows("SELECT seq, node_id, recorded_at FROM sync_conflict_log"):
        add_clock(row["recorded_at"] * 1000, f"CONFLICT recorded {row['node_id']} seq {row['seq']}")
    since = None
    if args.since:
        today = dt.date.today()
        since = dt.datetime.combine(today, dt.time.fromisoformat(args.since))
    for when, what in sorted(events):
        if since and when < since:
            continue
        print(f"{when:%Y-%m-%d %H:%M:%S}.{when.microsecond // 1000:03d}  {what}")
    return 0


def command_conflicts(state: State, _args) -> int:
    rows = state.rows("SELECT * FROM sync_conflict_log ORDER BY seq DESC")
    if not rows:
        print("The conflict log is empty.")
        print("Note: the log only holds what the merge decided to record.")
        print("The 'my own stamp, content I did not write' branch records nothing,")
        print("and Settings -> Overwritten notes can drop rows, so empty is not proof.")
        return 0
    for row in rows:
        print(f"seq {row['seq']}  {row['node_id']}  {show_ms(row['recorded_at'] * 1000)}")
        for side in ("loser", "winner"):
            try:
                body = json.loads(row[f"{side}_json"])
            except json.JSONDecodeError:
                body = row[f"{side}_json"]
            print(f"  {side:<7} t={row[f'{side}_hlc']}")
            print(f"          {body}")
        print()
    return 0


def command_dirty(state: State, _args) -> int:
    rows = state.rows(
        """SELECT d.node_id, d.marked_at, n.text, n.deleted
           FROM sync_dirty_nodes d LEFT JOIN notes_nodes n ON n.id = d.node_id
           ORDER BY d.marked_at"""
    )
    if not rows:
        print("Nothing owes a write.")
        return 0
    for row in rows:
        print(f"{row['node_id']:<16} marked {show_ms(row['marked_at'] * 1000)}  {row['text']!r}")
    return 0


def command_quarantine(state: State, _args) -> int:
    rows = state.rows("SELECT * FROM sync_quarantine ORDER BY noticed_at")
    if not rows:
        print("No quarantined files.")
        return 0
    for row in rows:
        print(f"{row['relative_path']}  {show_ms(row['noticed_at'] * 1000)}")
        print(f"  {row['reason']}")
    return 0


def command_doctor(state: State, _args) -> int:
    findings: list[str] = []
    device = state.device_id()

    others = [
        row["device_id"]
        for row in state.rows("SELECT device_id FROM sync_devices WHERE device_id <> ?", device)
    ]
    if others:
        findings.append(
            "Two identities write this vault: "
            + f"this instance is {device}, and the vault also carries {', '.join(others)}.\n"
            "    Every merge between them is this machine disagreeing with itself."
        )

    for directory in sorted(SUPPORT.glob("com.doortts.yonalist*")):
        if directory == state.data_dir:
            continue
        marker = directory / "vault-path"
        if not marker.is_file() or not state.vault:
            continue
        if marker.read_text(encoding="utf-8").strip() == str(state.vault):
            findings.append(
                f"{directory.name} points at the same vault as the live app.\n"
                "    Two databases, one folder: a second app is a second device."
            )

    for page in page_report(state):
        title = page["row_title"]
        if page["home_label"] is not None and page["home_label"] != title:
            findings.append(
                f"{page['id']}: home README says {page['home_label']!r}, "
                f"the database says {title!r}.\n"
                "    The index and the row disagree on the title."
            )
        if page["file_title"] is not None and page["file_title"] != title:
            findings.append(
                f"{page['id']}: its file says {page['file_title']!r}, "
                f"the database says {title!r}."
            )
        folder = (page["folder"] or "").split("/")[0]
        if not title and folder and folder != f"untitled-{page['id']}":
            remembered = folder[: -(len(page["id"]) + 1)]
            findings.append(
                f"{page['id']}: the page has no title, but its folder is still "
                f"{folder!r}.\n"
                f"    The folder is named once, from the title, and never renamed -- so this\n"
                f"    page was called {remembered!r} when the folder was made and has lost it since."
            )
        if page["exported_hlc"] and page["row_hlc"] != page["exported_hlc"]:
            findings.append(
                f"{page['id']}: the row is at {page['row_hlc']} but "
                f"{page['exported_hlc']} was written out."
            )

    stale = state.rows(
        "SELECT node_id, marked_at FROM sync_dirty_nodes WHERE marked_at < unixepoch() - 300"
    )
    for row in stale:
        findings.append(
            f"{row['node_id']} has owed a write since {show_ms(row['marked_at'] * 1000)}."
        )

    for row in state.rows("SELECT relative_path, reason FROM sync_quarantine"):
        findings.append(f"quarantined: {row['relative_path']} -- {row['reason']}")

    if not findings:
        print("Nothing to report.")
        return 0
    for finding in findings:
        print(f"  * {finding}")
    print(f"\n{len(findings)} finding(s).")
    return 1


def command_device(state: State, _args) -> int:
    """What this database stamps with, and what this machine would provision.

    The stored value always wins -- a device that has already stamped rows must
    not be renamed underneath them -- so a mismatch here is not a bug by itself.
    It means one of two things, and they need different answers: this database
    was provisioned before the derivation existed, or this data directory was
    copied from another Mac and two machines now share one identity.
    """
    stored = state.device_id()
    seed = machine_seed()
    print(f"stored in sync_meta   {stored}")
    if seed is None:
        print("this machine          gethostuuid failed -- nothing to derive from")
        print("\n  A provisioning now would fall back to a random value, which is the")
        print("  design that makes a reinstalled app a second device.")
        return 1
    scope = state.database_scope()
    print(f"IOPlatformUUID        {seed.hex()}")
    print(f"this database         {scope}")
    print(
        f"would provision       {derived_device_id(seed, scope)}   "
        f"(sha256 of the two above, {DEVICE_WIDTH} hex)"
    )
    if stored == derived_device_id(seed, scope):
        print("\n  Stored and derived agree: this machine is stable across a reinstall.")
        return 0
    print(f"\n  Stored {stored!r} is not what this machine and place derive.")
    print("  Either it predates the derivation, or this data directory came from")
    print("  another Mac -- in which case two machines are stamping as one device.")
    return 1


def command_widen_stamps(state: State, args) -> int:
    """Rewrites the vault's readings at this build's device width.

    Needed once, by a vault written before the device field went from four
    characters to eight. Every reading in such a folder is one this build cannot
    decode, and the reader treats what it cannot decode as "never stamped" --
    the same value a hand-typed line gets. That is survivable for one line and
    ruinous for a whole vault: with no reading anywhere, no ordering claim can
    be accepted, and pages come to rest on the placeholder key the trash left
    behind. Three live pages on one key is a tree the app refuses to touch.

    The notes themselves are not read or changed. Only frontmatter reading keys,
    `device_id`, and the footer's `t:` / `prev:` tokens.
    """
    if state.vault is None:
        print(f"No vault recorded at {state.data_dir / 'vault-path'}.")
        return 1
    if state.db is None:
        print(f"(no database here -- reading the vault only: {state.vault})")
    files = sorted(state.vault.rglob("*.md"))
    if not files:
        print(f"No documents under {state.vault}")
        return 1
    total = 0
    for path in files:
        original = path.read_text(encoding="utf-8")
        widened = "\n".join(widen_stamp_line(line) for line in original.split("\n"))
        if widened == original:
            print(f"  unchanged  {path.relative_to(state.vault)}")
            continue
        changes = sum(
            1
            for before, after in zip(original.split("\n"), widened.split("\n"))
            if before != after
        )
        total += changes
        print(f"  {changes:>4} line(s)  {path.relative_to(state.vault)}")
        if args.apply:
            path.write_text(widened, encoding="utf-8")
    if not args.apply:
        print(f"\n{total} line(s) would change. Nothing written -- pass --apply.")
        return 0
    print(f"\n{total} line(s) rewritten.")
    print("The database still holds the old readings, so it has to go: quit the")
    print("app, remove its sqlite files, and start it again. The notes are in the")
    print("vault and come back from there.")
    return 0

def command_hlc(_state, args) -> int:
    print(show_hlc(args.stamp))
    return 0


def selftest() -> int:
    # The one piece of real logic here is the stamp decoding: everything else
    # is a query. `0mt196sb0-00-52e4` is 2026-08-20 17:23:17.196 local.
    parts = hlc_parts("0mt196sb0-00-52e4")
    assert parts is not None
    millis, counter, device = parts
    assert counter == 0 and device == "52e4", parts
    assert millis == 1787214197196, millis
    assert hlc_parts("nope") is None
    assert hlc_parts("0mt196sb0x00-52e4") is None
    # String order has to be time order, or nothing in the vault sorts.
    assert "0mt195asu-00-52e4" < "0mt196sb0-00-52e4"
    assert hlc_time("0mt195asu-00-52e4") < hlc_time("0mt196sb0-00-52e4")
    assert show_ms(None) == "--"
    assert unescape_inline("Lessons &amp; Learned") == "Lessons & Learned"
    assert unescape_inline(r"a\\b") == r"a\b"
    assert unescape_inline(r"\[x\]") == "[x]"
    assert unescape_inline(r"one\ntwo") == "one\ntwo"
    # Derivation is a pure hash: same bytes in, same four characters out,
    # which is the whole property a reinstall depends on.
    assert derived_device_id(bytes(range(16)), "/a") == derived_device_id(bytes(range(16)), "/a")
    assert len(derived_device_id(b"x", "/a")) == DEVICE_WIDTH
    assert len(derived_device_id(b"x", "/a", 4)) == 4
    assert derived_device_id(b"x", "/a") != derived_device_id(b"y", "/a")
    # Same machine, different place: a different writer.
    assert derived_device_id(b"x", "/a") != derived_device_id(b"x", "/b")
    # And the separator keeps a machine-and-place pair from spelling another.
    assert derived_device_id(b"x", "y") != derived_device_id(b"xy", "")
    # Widening keeps the order the old readings were in, and touches only the
    # lines that carry one.
    assert widen_stamp_line("root_hlc: 0mt195asu-00-52e4") == "root_hlc: 0mt195asu-00-52e40000"
    assert widen_stamp_line("device_id: 52e4") == "device_id: 52e40000"
    assert widen_stamp_line("device_id: cad27a0b") == "device_id: cad27a0b"
    assert widen_stamp_line("root_hlc: 0mt195asu-00-52e40000") == "root_hlc: 0mt195asu-00-52e40000"
    assert (
        widen_stamp_line("yid: rDibyYosWVJY t: 0mt195asu-00-52e4 split prev: aB@0mt0g7jil-00-52e4")
        == "yid: rDibyYosWVJY t: 0mt195asu-00-52e40000 split prev: aB@0mt0g7jil-00-52e40000"
    )
    # Prose is left alone, readings or not.
    assert widen_stamp_line("- 0mt195asu-00-52e4 라고 적어 뒀다") == "- 0mt195asu-00-52e4 라고 적어 뒀다"
    old = ["0mt195asu-00-52e4", "0mt196sb0-00-52e4"]
    new = [widen_stamp_line(f"root_hlc: {value}") for value in old]
    assert new == sorted(new), "widening must not reorder what the vault already ordered"
    print("selftest ok")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--data-dir",
        type=pathlib.Path,
        default=pathlib.Path(os.environ.get("YONALIST_V2_DATA_DIR", DEFAULT_DATA_DIR)),
        help="the app's data directory (default: the release app's)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="checks worth running first")
    sub.add_parser("instances", help="who else writes this vault")
    sub.add_parser("device", help="stored device id vs what this machine derives")
    sub.add_parser("pages", help="each page's title in the database and in the vault")
    node = sub.add_parser("node", help="everything the state holds about one node")
    node.add_argument("id")
    timeline = sub.add_parser("timeline", help="every stamp in time order")
    timeline.add_argument("--since", help="local time today, e.g. 17:00")
    sub.add_parser("conflicts", help="the overwrite log")
    sub.add_parser("dirty", help="what still owes a write to the vault")
    sub.add_parser("quarantine", help="files the parser refused")
    widen = sub.add_parser(
        "widen-stamps", help="rewrite a vault written at the old device width"
    )
    widen.add_argument(
        "--apply", action="store_true", help="write the files (default: dry run)"
    )
    stamp = sub.add_parser("hlc", help="decode one stamp")
    stamp.add_argument("stamp")
    sub.add_parser("selftest", help="check this script's own logic")

    args = parser.parse_args(argv)
    if args.command == "selftest":
        return selftest()
    commands = {
        "doctor": command_doctor,
        "instances": command_instances,
        "device": command_device,
        "pages": command_pages,
        "node": command_node,
        "timeline": command_timeline,
        "conflicts": command_conflicts,
        "dirty": command_dirty,
        "quarantine": command_quarantine,
        "widen-stamps": command_widen_stamps,
        "hlc": command_hlc,
    }
    state = State(args.data_dir, needs_db=args.command != "widen-stamps")
    return commands[args.command](state, args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
