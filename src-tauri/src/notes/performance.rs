use crate::notes::date_index::LocalDate;
use crate::notes::history::{
    clear_history, history_status, undo, with_history_transaction, HISTORY_MAX_ENTRIES,
};
use crate::notes::repository::{
    archive_node, connect_notes_db, load_workspace, rebuild_derived_for_nodes_at, search_nodes_at,
    search_nodes_structured, toggle_star, unarchive_node, update_node_at,
};
use crate::notes::types::{
    NoteLayoutMode, NoteNode, NoteSearchScope, NoteSearchTag, NoteStructuredSearchQuery,
    NoteTagPrefix, NotesHistoryContext, NotesWorkspace, NotesWorkspaceScope, UpdateNodeInput,
};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const WARMUP_SAMPLES: usize = 5;
const MEASURED_SAMPLES: usize = 31;
const VAULT_SIZES: [usize; 2] = [1_000, 10_000];
const ARCHIVE_SUBTREE_SIZE: usize = 100;
const FIXED_TIMESTAMP: &str = "2026-07-12T00:00:00.000Z";
const DATE_RANGE_QUERY: &str = "07/10/2026 - 07/12/2026";
const HISTORY_SESSION_ID: &str = "90000000-0000-4000-8000-000000000001";
const REGRESSION_LIMIT: f64 = 1.20;

// Maximum per-statistic values from repeated captures on 2026-07-12 with
// rustc 1.96.1, macOS 15.7.1, Apple M1 Pro, aarch64-apple-darwin, --release,
// 5 warmups, and 31 measured samples. Values are normalized nanoseconds per
// vault node; the final gate allows +20%.
const BASELINE_METADATA: &str =
    "2026-07-12|Apple M1 Pro|macOS 15.7.1|rustc 1.96.1|release|5w+31m|max-observed";

#[derive(Clone, Copy)]
struct Baseline {
    node_count: usize,
    workload: &'static str,
    median_ns_per_node: f64,
    p95_ns_per_node: f64,
}

const BASELINES: [Baseline; 14] = [
    Baseline {
        node_count: 1_000,
        workload: "active_load",
        median_ns_per_node: 1_552.0,
        p95_ns_per_node: 4_841.0,
    },
    Baseline {
        node_count: 1_000,
        workload: "tag_and_or_not",
        median_ns_per_node: 1_359.0,
        p95_ns_per_node: 1_777.8,
    },
    Baseline {
        node_count: 1_000,
        workload: "date_range",
        median_ns_per_node: 830.0,
        p95_ns_per_node: 1_236.2,
    },
    Baseline {
        node_count: 1_000,
        workload: "archive",
        median_ns_per_node: 25_566.0,
        p95_ns_per_node: 39_993.4,
    },
    Baseline {
        node_count: 1_000,
        workload: "unarchive",
        median_ns_per_node: 14_680.0,
        p95_ns_per_node: 35_106.0,
    },
    Baseline {
        node_count: 1_000,
        workload: "mutation_undo",
        median_ns_per_node: 8_122.0,
        p95_ns_per_node: 16_676.6,
    },
    Baseline {
        node_count: 1_000,
        workload: "history_eviction",
        median_ns_per_node: 2_288.0,
        p95_ns_per_node: 2_937.6,
    },
    Baseline {
        node_count: 10_000,
        workload: "active_load",
        median_ns_per_node: 2_020.9,
        p95_ns_per_node: 5_908.5,
    },
    Baseline {
        node_count: 10_000,
        workload: "tag_and_or_not",
        median_ns_per_node: 1_347.5,
        p95_ns_per_node: 1_442.3,
    },
    Baseline {
        node_count: 10_000,
        workload: "date_range",
        median_ns_per_node: 822.2,
        p95_ns_per_node: 906.0,
    },
    Baseline {
        node_count: 10_000,
        workload: "archive",
        median_ns_per_node: 27_883.4,
        p95_ns_per_node: 55_277.0,
    },
    Baseline {
        node_count: 10_000,
        workload: "unarchive",
        median_ns_per_node: 13_225.0,
        p95_ns_per_node: 15_107.4,
    },
    Baseline {
        node_count: 10_000,
        workload: "mutation_undo",
        median_ns_per_node: 5_466.5,
        p95_ns_per_node: 8_081.7,
    },
    Baseline {
        node_count: 10_000,
        workload: "history_eviction",
        median_ns_per_node: 2_012.8,
        p95_ns_per_node: 2_369.8,
    },
];

struct PerfVault {
    _directory: TempDir,
    connection: Connection,
    node_count: usize,
    archive_root_id: String,
    root_title: String,
    root_note: String,
    structured_ids: Vec<String>,
    structured_without_required_ids: Vec<String>,
    structured_without_or_ids: Vec<String>,
    structured_without_not_ids: Vec<String>,
    date_ids: Vec<String>,
}

struct Measurement {
    node_count: usize,
    workload: &'static str,
    median_ns: u128,
    p95_ns: u128,
}

#[derive(Debug, PartialEq, Eq)]
struct SubtreeNodeProjection {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    layout_mode: NoteLayoutMode,
    is_collapsed: bool,
    is_starred: bool,
    completed_at: Option<String>,
    created_at: String,
    deleted_at: Option<String>,
    is_archived: bool,
    archive_root_id: Option<String>,
}

impl SubtreeNodeProjection {
    fn from_node(node: &NoteNode) -> Self {
        Self {
            id: node.id.clone(),
            parent_id: node.parent_id.clone(),
            sort_key: node.sort_key,
            title: node.title.clone(),
            note: node.note.clone(),
            layout_mode: node.layout_mode,
            is_collapsed: node.is_collapsed,
            is_starred: node.is_starred,
            completed_at: node.completed_at.clone(),
            created_at: node.created_at.clone(),
            deleted_at: node.deleted_at.clone(),
            is_archived: node.archived_at.is_some(),
            archive_root_id: node.archive_root_id.clone(),
        }
    }
}

fn fixed_today() -> LocalDate {
    LocalDate::new(2026, 7, 12).expect("fixed performance date")
}

fn node_id(index: usize) -> String {
    format!("10000000-0000-4000-8000-{index:012x}")
}

fn history_entry_id(namespace: u8, index: usize) -> String {
    format!("{namespace:08x}-0000-4000-8000-{index:012x}")
}

fn history_context(namespace: u8, index: usize, command_kind: &str) -> NotesHistoryContext {
    NotesHistoryContext {
        session_id: HISTORY_SESSION_ID.to_string(),
        entry_id: history_entry_id(namespace, index),
        command_kind: command_kind.to_string(),
    }
}

fn search_tag(prefix: NoteTagPrefix, tag: &str) -> NoteSearchTag {
    NoteSearchTag {
        prefix,
        normalized_tag: tag.to_string(),
        display_tag: tag.to_string(),
    }
}

fn structured_query() -> NoteStructuredSearchQuery {
    NoteStructuredSearchQuery {
        text: String::new(),
        required_tags: vec![search_tag(NoteTagPrefix::Hash, "project")],
        excluded_tags: vec![search_tag(NoteTagPrefix::Hash, "blocked")],
        or_groups: vec![vec![
            search_tag(NoteTagPrefix::Mention, "alice"),
            search_tag(NoteTagPrefix::Mention, "bob"),
        ]],
    }
}

#[derive(Clone, Copy)]
struct FixtureTags {
    project: bool,
    mention: Option<&'static str>,
    blocked: bool,
}

impl FixtureTags {
    fn passes_or(self) -> bool {
        matches!(self.mention, Some("alice" | "bob"))
    }
}

fn fixture_tags(index: usize) -> FixtureTags {
    match index {
        1 => FixtureTags {
            project: false,
            mention: Some("alice"),
            blocked: false,
        },
        2 => FixtureTags {
            project: true,
            mention: None,
            blocked: false,
        },
        3 => FixtureTags {
            project: true,
            mention: Some("bob"),
            blocked: true,
        },
        _ if index % 2 == 0 => FixtureTags {
            project: true,
            mention: Some(if index % 4 == 0 { "alice" } else { "bob" }),
            blocked: index % 10 == 0,
        },
        _ => FixtureTags {
            project: false,
            mention: Some("carol"),
            blocked: false,
        },
    }
}

fn push_expected_id(ids: &mut Vec<String>, id: &str, matches: bool) {
    if matches && ids.len() < 100 {
        ids.push(id.to_string());
    }
}

fn fixture_text(index: usize) -> (String, String) {
    let tags = fixture_tags(index);
    let mut title = format!("Node {index:05}");
    if tags.project {
        title.push_str(" #project");
    } else {
        title.push_str(" #inbox");
    }
    if let Some(mention) = tags.mention {
        title.push_str(" @");
        title.push_str(mention);
    }
    if tags.blocked {
        title.push_str(" #blocked");
    }
    let note = if index % 3 == 0 {
        "Scheduled for 07/11/2026".to_string()
    } else {
        "Deterministic performance fixture".to_string()
    };
    (title, note)
}

impl PerfVault {
    fn create(node_count: usize) -> Self {
        assert_eq!(node_count % ARCHIVE_SUBTREE_SIZE, 0);
        let directory = tempfile::tempdir().expect("performance vault temp dir");
        let mut connection = connect_notes_db(
            directory
                .path()
                .to_str()
                .expect("performance vault path must be UTF-8"),
        )
        .expect("initialize performance vault schema");
        let transaction = connection
            .transaction()
            .expect("start performance fixture transaction");
        let mut ids = BTreeSet::new();
        let mut structured_ids = Vec::new();
        let mut structured_without_required_ids = Vec::new();
        let mut structured_without_or_ids = Vec::new();
        let mut structured_without_not_ids = Vec::new();
        let mut date_ids = Vec::new();
        let (root_title, root_note) = fixture_text(0);

        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO notes_nodes (id, parent_id, sort_key, title, note, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                )
                .expect("prepare deterministic performance nodes");
            for index in 0..node_count {
                let id = node_id(index);
                let group_start = index / ARCHIVE_SUBTREE_SIZE * ARCHIVE_SUBTREE_SIZE;
                let parent_id = (index != group_start).then(|| node_id(group_start));
                let sort_key = if index == group_start {
                    (group_start / ARCHIVE_SUBTREE_SIZE + 1) as i64 * 1_024
                } else {
                    (index - group_start) as i64 * 1_024
                };
                let tags = fixture_tags(index);
                let (title, note) = fixture_text(index);
                insert
                    .execute(params![
                        id,
                        parent_id,
                        sort_key,
                        title,
                        note,
                        FIXED_TIMESTAMP
                    ])
                    .expect("insert deterministic performance node");
                ids.insert(id.clone());
                push_expected_id(
                    &mut structured_ids,
                    &id,
                    tags.project && tags.passes_or() && !tags.blocked,
                );
                push_expected_id(
                    &mut structured_without_required_ids,
                    &id,
                    tags.passes_or() && !tags.blocked,
                );
                push_expected_id(
                    &mut structured_without_or_ids,
                    &id,
                    tags.project && !tags.blocked,
                );
                push_expected_id(
                    &mut structured_without_not_ids,
                    &id,
                    tags.project && tags.passes_or(),
                );
                if index % 3 == 0 && date_ids.len() < 100 {
                    date_ids.push(id);
                }
            }
        }

        rebuild_derived_for_nodes_at(&transaction, &ids, fixed_today())
            .expect("build production tag and date indexes");
        transaction
            .commit()
            .expect("commit deterministic performance vault");

        let vault = Self {
            _directory: directory,
            connection,
            node_count,
            archive_root_id: node_id(0),
            root_title,
            root_note,
            structured_ids,
            structured_without_required_ids,
            structured_without_or_ids,
            structured_without_not_ids,
            date_ids,
        };
        vault.verify_active(
            &load_workspace(&vault.connection, NotesWorkspaceScope::Active)
                .expect("verify seeded active workspace"),
        );
        vault
    }

    fn verify_active(&self, workspace: &NotesWorkspace) {
        assert_eq!(workspace.nodes.len(), self.node_count);
        assert!(workspace.attachments_by_node_id.is_empty());
        let root = workspace
            .nodes
            .iter()
            .find(|node| node.id == self.archive_root_id)
            .expect("active performance root");
        assert_eq!(root.title, self.root_title);
        assert_eq!(root.note, self.root_note);
        assert!(root.archived_at.is_none());
        assert!(root.deleted_at.is_none());
    }

    fn expected_subtree_projection(&self, archived: bool) -> Vec<SubtreeNodeProjection> {
        (0..ARCHIVE_SUBTREE_SIZE)
            .map(|index| {
                let (title, note) = fixture_text(index);
                SubtreeNodeProjection {
                    id: node_id(index),
                    parent_id: (index != 0).then(|| self.archive_root_id.clone()),
                    sort_key: if index == 0 {
                        1_024
                    } else {
                        index as i64 * 1_024
                    },
                    title,
                    note,
                    layout_mode: NoteLayoutMode::Bullets,
                    is_collapsed: false,
                    is_starred: false,
                    completed_at: None,
                    created_at: FIXED_TIMESTAMP.to_string(),
                    deleted_at: None,
                    is_archived: archived,
                    archive_root_id: archived.then(|| self.archive_root_id.clone()),
                }
            })
            .collect()
    }

    fn verify_archived_subtree(&self, workspace: &NotesWorkspace) -> Result<(), String> {
        if !workspace.attachments_by_node_id.is_empty() {
            return Err("Archived performance subtree unexpectedly contained attachments.".into());
        }
        let actual = workspace
            .nodes
            .iter()
            .map(SubtreeNodeProjection::from_node)
            .collect::<Vec<_>>();
        let expected = self.expected_subtree_projection(true);
        if actual != expected {
            return Err(format!(
                "Archived performance subtree projection mismatch.\nexpected: {expected:#?}\nactual: {actual:#?}"
            ));
        }
        let archived_at = workspace
            .nodes
            .first()
            .and_then(|node| node.archived_at.as_deref())
            .ok_or_else(|| "Archived performance root had no archive timestamp.".to_string())?;
        if workspace.nodes.iter().any(|node| {
            node.archived_at.as_deref() != Some(archived_at) || node.updated_at != archived_at
        }) {
            return Err(
                "Archived performance subtree did not share one authoritative timestamp."
                    .to_string(),
            );
        }
        Ok(())
    }

    fn verify_unarchived_subtree(&self, workspace: &NotesWorkspace) -> Result<(), String> {
        let subtree_ids = (0..ARCHIVE_SUBTREE_SIZE)
            .map(node_id)
            .collect::<BTreeSet<_>>();
        let actual = workspace
            .nodes
            .iter()
            .filter(|node| subtree_ids.contains(&node.id))
            .map(SubtreeNodeProjection::from_node)
            .collect::<Vec<_>>();
        let expected = self.expected_subtree_projection(false);
        if actual != expected {
            return Err(format!(
                "Unarchived performance subtree projection mismatch.\nexpected: {expected:#?}\nactual: {actual:#?}"
            ));
        }
        Ok(())
    }
}

fn duration_of<T>(operation: impl FnOnce() -> T) -> (Duration, T) {
    let started = Instant::now();
    let result = operation();
    (started.elapsed(), result)
}

fn summarize(mut samples: Vec<Duration>) -> (u128, u128) {
    assert_eq!(samples.len(), MEASURED_SAMPLES);
    samples.sort_unstable();
    let median = samples[samples.len() / 2].as_nanos();
    let p95_rank = (95 * samples.len()).div_ceil(100);
    let p95 = samples[p95_rank - 1].as_nanos();
    (median, p95)
}

fn measure(
    node_count: usize,
    workload: &'static str,
    mut sample: impl FnMut(usize) -> Duration,
) -> Measurement {
    let mut measured = Vec::with_capacity(MEASURED_SAMPLES);
    for iteration in 0..(WARMUP_SAMPLES + MEASURED_SAMPLES) {
        let elapsed = sample(iteration);
        if iteration >= WARMUP_SAMPLES {
            measured.push(elapsed);
        }
    }
    let (median_ns, p95_ns) = summarize(measured);
    Measurement {
        node_count,
        workload,
        median_ns,
        p95_ns,
    }
}

fn measure_vault(vault: &mut PerfVault) -> Vec<Measurement> {
    let node_count = vault.node_count;
    let mut measurements = Vec::with_capacity(7);

    measurements.push(measure(node_count, "active_load", |_| {
        let (elapsed, workspace) = duration_of(|| {
            load_workspace(&vault.connection, NotesWorkspaceScope::Active)
                .expect("sample active workspace")
        });
        vault.verify_active(&workspace);
        elapsed
    }));

    let query = structured_query();
    measurements.push(measure(node_count, "tag_and_or_not", |_| {
        let (elapsed, matches) = duration_of(|| {
            search_nodes_structured(&vault.connection, &query)
                .expect("sample structured AND/OR/NOT search")
        });
        assert_eq!(
            matches
                .iter()
                .map(|result| result.node_id.as_str())
                .collect::<Vec<_>>(),
            vault
                .structured_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        elapsed
    }));

    measurements.push(measure(node_count, "date_range", |_| {
        let (elapsed, matches) = duration_of(|| {
            search_nodes_at(
                &vault.connection,
                DATE_RANGE_QUERY,
                NoteSearchScope::Active,
                fixed_today(),
            )
            .expect("sample production date range search")
        });
        assert_eq!(
            matches
                .iter()
                .map(|result| result.node_id.as_str())
                .collect::<Vec<_>>(),
            vault
                .date_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        elapsed
    }));

    measurements.push(measure(node_count, "archive", |_| {
        let (elapsed, active) = duration_of(|| {
            archive_node(&mut vault.connection, &vault.archive_root_id)
                .expect("sample archive operation")
        });
        assert_eq!(active.nodes.len(), node_count - ARCHIVE_SUBTREE_SIZE);
        assert!((0..ARCHIVE_SUBTREE_SIZE)
            .map(node_id)
            .all(|id| active.nodes.iter().all(|node| node.id != id)));
        let archived = load_workspace(&vault.connection, NotesWorkspaceScope::Archive)
            .expect("verify sampled archive");
        vault
            .verify_archived_subtree(&archived)
            .expect("verify exact sampled archived subtree");
        let restored = unarchive_node(&mut vault.connection, &vault.archive_root_id)
            .expect("reset sampled archive");
        vault.verify_active(&restored);
        vault
            .verify_unarchived_subtree(&restored)
            .expect("verify exact reset unarchived subtree");
        elapsed
    }));

    measurements.push(measure(node_count, "unarchive", |_| {
        archive_node(&mut vault.connection, &vault.archive_root_id)
            .expect("prepare sampled unarchive");
        let (elapsed, active) = duration_of(|| {
            unarchive_node(&mut vault.connection, &vault.archive_root_id)
                .expect("sample unarchive operation")
        });
        vault.verify_active(&active);
        vault
            .verify_unarchived_subtree(&active)
            .expect("verify exact sampled unarchived subtree");
        assert!(
            load_workspace(&vault.connection, NotesWorkspaceScope::Archive)
                .expect("verify sampled unarchive")
                .nodes
                .is_empty()
        );
        elapsed
    }));

    measurements.push(measure(node_count, "mutation_undo", |iteration| {
        clear_history(&mut vault.connection, HISTORY_SESSION_ID)
            .expect("clear mutation performance history");
        let context = history_context(0x20, iteration, "updateText");
        let updated_title = format!("Performance mutation {iteration}");
        let (elapsed, replay) = duration_of(|| {
            with_history_transaction(&mut vault.connection, Some(&context), |connection| {
                update_node_at(
                    connection,
                    UpdateNodeInput {
                        id: vault.archive_root_id.clone(),
                        title: updated_title,
                        note: vault.root_note.clone(),
                    },
                    fixed_today(),
                )
            })
            .expect("sample journaled mutation");
            undo(
                &mut vault.connection,
                HISTORY_SESSION_ID,
                NotesWorkspaceScope::Active,
            )
            .expect("sample production undo")
        });
        assert_eq!(
            replay.replayed_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        assert!(replay.can_redo);
        vault.verify_active(&replay.workspace);
        elapsed
    }));

    measurements.push(measure(node_count, "history_eviction", |iteration| {
        clear_history(&mut vault.connection, HISTORY_SESSION_ID)
            .expect("clear eviction performance history");
        for index in 0..HISTORY_MAX_ENTRIES as usize {
            let context = history_context(0x30, index, "toggleStar");
            with_history_transaction(&mut vault.connection, Some(&context), |connection| {
                toggle_star(connection, &vault.archive_root_id)
            })
            .expect("seed production history eviction entry");
        }
        let oldest_id = history_entry_id(0x30, 0);
        let newest = history_context(0x40, iteration, "toggleStar");
        let (elapsed, workspace) = duration_of(|| {
            with_history_transaction(&mut vault.connection, Some(&newest), |connection| {
                toggle_star(connection, &vault.archive_root_id)
            })
            .expect("sample production history eviction")
        });
        assert_eq!(workspace.nodes.len(), node_count);
        assert!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == vault.archive_root_id)
                .expect("eviction root")
                .is_starred
        );
        let (entry_count, oldest_exists, newest_exists): (i64, bool, bool) = vault
            .connection
            .query_row(
                "SELECT COUNT(*), \
                        EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1), \
                        EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?2) \
                 FROM notes_history_entries",
                params![oldest_id, newest.entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("verify sampled production history eviction");
        assert_eq!(entry_count, HISTORY_MAX_ENTRIES);
        assert!(!oldest_exists);
        assert!(newest_exists);
        assert!(
            history_status(&vault.connection, HISTORY_SESSION_ID)
                .expect("verify eviction history status")
                .can_undo
        );
        clear_history(&mut vault.connection, HISTORY_SESSION_ID)
            .expect("reset eviction performance history");
        let reset = toggle_star(&mut vault.connection, &vault.archive_root_id)
            .expect("reset eviction star state");
        vault.verify_active(&reset);
        elapsed
    }));

    measurements
}

fn baseline_for(measurement: &Measurement) -> Baseline {
    BASELINES
        .iter()
        .copied()
        .find(|baseline| {
            baseline.node_count == measurement.node_count
                && baseline.workload == measurement.workload
        })
        .expect("recorded performance baseline")
}

fn print_and_gate(measurements: &[Measurement], enforce_gate: bool) {
    println!(
        "notes_perf metadata={} samples={}+{} gate={} profile={}",
        BASELINE_METADATA,
        WARMUP_SAMPLES,
        MEASURED_SAMPLES,
        if enforce_gate { "+20%" } else { "diagnostic" },
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    println!("nodes workload          median_ms   p95_ms   p95_ns/node ratio status");
    let mut regressions = Vec::new();
    for measurement in measurements {
        let baseline = baseline_for(measurement);
        let nodes = measurement.node_count as f64;
        let median_per_node = measurement.median_ns as f64 / nodes;
        let p95_per_node = measurement.p95_ns as f64 / nodes;
        let ratio = (median_per_node / baseline.median_ns_per_node)
            .max(p95_per_node / baseline.p95_ns_per_node);
        let passed = !enforce_gate || ratio <= REGRESSION_LIMIT;
        println!(
            "{:>5} {:<17} {:>9.3} {:>8.3} {:>13.1} {:>5.2} {}",
            measurement.node_count,
            measurement.workload,
            measurement.median_ns as f64 / 1_000_000.0,
            measurement.p95_ns as f64 / 1_000_000.0,
            p95_per_node,
            ratio,
            if passed { "ok" } else { "REGRESSION" }
        );
        if !passed {
            regressions.push(format!(
                "{}@{} nodes {:.2}x (limit {:.2}x)",
                measurement.workload, measurement.node_count, ratio, REGRESSION_LIMIT
            ));
        }
    }
    io::stdout().flush().expect("flush Notes performance table");
    assert!(
        regressions.is_empty(),
        "Notes performance regressions: {}",
        regressions.join(", ")
    );
}

fn run_performance_harness() {
    if std::env::var_os("NOTES_PERF").as_deref() != Some(OsStr::new("1")) {
        println!("notes_perf skipped: set NOTES_PERF=1 (use --release for regression gates)");
        return;
    }

    static SERIAL: OnceLock<Mutex<()>> = OnceLock::new();
    let _serial = SERIAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("serialize Notes performance harness");

    let mut measurements = Vec::with_capacity(VAULT_SIZES.len() * 7);
    for node_count in VAULT_SIZES {
        let mut vault = PerfVault::create(node_count);
        measurements.extend(measure_vault(&mut vault));
    }
    print_and_gate(&measurements, !cfg!(debug_assertions));
}

#[test]
fn structured_performance_fixture_falsifies_each_boolean_clause() {
    let vault = PerfVault::create(1_000);
    let full_matches = search_nodes_structured(&vault.connection, &structured_query())
        .expect("full structured performance search");
    let full_ids = full_matches
        .iter()
        .map(|result| result.node_id.as_str())
        .collect::<Vec<_>>();

    let mut without_required = structured_query();
    without_required.required_tags.clear();
    let without_required_ids = search_nodes_structured(&vault.connection, &without_required)
        .expect("structured search without required clause")
        .into_iter()
        .map(|result| result.node_id)
        .collect::<Vec<_>>();

    let mut without_or = structured_query();
    without_or.or_groups.clear();
    let without_or_ids = search_nodes_structured(&vault.connection, &without_or)
        .expect("structured search without OR clause")
        .into_iter()
        .map(|result| result.node_id)
        .collect::<Vec<_>>();

    let mut without_not = structured_query();
    without_not.excluded_tags.clear();
    let without_not_ids = search_nodes_structured(&vault.connection, &without_not)
        .expect("structured search without NOT clause")
        .into_iter()
        .map(|result| result.node_id)
        .collect::<Vec<_>>();

    assert_eq!(
        full_ids,
        vault
            .structured_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
    assert_eq!(without_required_ids, vault.structured_without_required_ids);
    assert_eq!(without_or_ids, vault.structured_without_or_ids);
    assert_eq!(without_not_ids, vault.structured_without_not_ids);
    assert!(!full_ids.contains(&node_id(1).as_str()));
    assert!(without_required_ids.contains(&node_id(1)));
    assert!(!full_ids.contains(&node_id(2).as_str()));
    assert!(without_or_ids.contains(&node_id(2)));
    assert!(!full_ids.contains(&node_id(3).as_str()));
    assert!(without_not_ids.contains(&node_id(3)));
}

#[test]
fn archive_performance_fixture_checks_exact_subtree_projection() {
    let mut vault = PerfVault::create(1_000);
    let active_after_archive = archive_node(&mut vault.connection, &vault.archive_root_id)
        .expect("archive focused performance fixture");
    assert_eq!(active_after_archive.nodes.len(), 900);
    let archived = load_workspace(&vault.connection, NotesWorkspaceScope::Archive)
        .expect("load focused archived performance fixture");
    vault
        .verify_archived_subtree(&archived)
        .expect("exact archived subtree");

    let mut wrong_order = archived.clone();
    wrong_order.nodes.swap(1, 2);
    assert!(vault.verify_archived_subtree(&wrong_order).is_err());

    let mut wrong_parent = archived.clone();
    wrong_parent.nodes[1].parent_id = None;
    assert!(vault.verify_archived_subtree(&wrong_parent).is_err());

    let mut wrong_state = archived.clone();
    wrong_state.nodes[1].archived_at = None;
    assert!(vault.verify_archived_subtree(&wrong_state).is_err());

    let active = unarchive_node(&mut vault.connection, &vault.archive_root_id)
        .expect("unarchive focused performance fixture");
    vault
        .verify_unarchived_subtree(&active)
        .expect("exact unarchived subtree");

    let mut wrong_unarchived_state = active.clone();
    wrong_unarchived_state
        .nodes
        .iter_mut()
        .find(|node| node.id == node_id(1))
        .expect("focused child")
        .archive_root_id = Some(vault.archive_root_id.clone());
    assert!(vault
        .verify_unarchived_subtree(&wrong_unarchived_state)
        .is_err());
}

#[test]
#[ignore = "run with NOTES_PERF=1 cargo test --release notes_interaction_expansion_performance -- --ignored --test-threads=1 --nocapture"]
fn notes_interaction_expansion_performance() {
    run_performance_harness();
}
