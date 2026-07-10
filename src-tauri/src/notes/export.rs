use super::types::NotesExportSnapshot;
use rusqlite::Connection;
use std::fmt::Write;

pub(crate) fn load_export_snapshot(
    connection: &Connection,
    root_node_id: &str,
) -> Result<NotesExportSnapshot, String> {
    super::repository::load_export_snapshot(connection, root_node_id)
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            character if character.is_ascii_punctuation() => {
                escaped.push('\\');
                escaped.push(character);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn escape_inline(value: &str) -> String {
    normalize_newlines(value)
        .split('\n')
        .map(escape_markdown)
        .collect::<Vec<_>>()
        .join(r"\n")
}

fn render_node(markdown: &mut String, node: &super::types::ExportNode, depth: usize) {
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    writeln!(
        markdown,
        "{indentation}- [{completion}] {} <!-- yonalist-node-id: {} -->",
        escape_inline(&node.title),
        node.id
    )
    .expect("writing to a String cannot fail");

    if !node.note.is_empty() {
        let note_indentation = "  ".repeat(depth + 1);
        for line in normalize_newlines(&node.note).split('\n') {
            if line.is_empty() {
                writeln!(markdown, "{note_indentation}>").expect("writing to a String cannot fail");
            } else {
                writeln!(markdown, "{note_indentation}> {}", escape_markdown(line))
                    .expect("writing to a String cannot fail");
            }
        }
    }

    for child in &node.children {
        render_node(markdown, child, depth + 1);
    }
}

pub(crate) fn render_markdown(snapshot: &NotesExportSnapshot) -> Vec<u8> {
    let mut markdown = String::new();
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes-export").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: 1").expect("writing to a String cannot fail");
    writeln!(markdown, "source: notes.sqlite").expect("writing to a String cannot fail");
    writeln!(markdown, "root_node_id: \"{}\"", snapshot.root_node_id)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "exported_at: \"{}\"", snapshot.exported_at)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "---\n").expect("writing to a String cannot fail");
    writeln!(markdown, "# {}\n", escape_inline(&snapshot.title))
        .expect("writing to a String cannot fail");
    render_node(&mut markdown, &snapshot.root, 0);
    markdown.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::{load_export_snapshot, render_markdown};
    use crate::notes::types::{ExportNode, NotesExportSnapshot};
    use rusqlite::{params, Connection};

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const FIRST_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ID: &str = "33333333-3333-4333-8333-333333333333";
    const LATER_ID: &str = "44444444-4444-4444-8444-444444444444";
    const DELETED_ID: &str = "55555555-5555-4555-8555-555555555555";
    const COLLAPSED_CHILD_ID: &str = "66666666-6666-4666-8666-666666666666";

    fn export_node(
        id: &str,
        title: &str,
        note: &str,
        completed: bool,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        ExportNode {
            id: id.to_string(),
            title: title.to_string(),
            note: note.to_string(),
            completed,
            children,
        }
    }

    fn snapshot(root: ExportNode) -> NotesExportSnapshot {
        NotesExportSnapshot {
            root_node_id: root.id.clone(),
            title: root.title.clone(),
            exported_at: "2026-07-10T12:34:56.789Z".to_string(),
            root,
        }
    }

    fn export_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE notes_nodes (\
                   id TEXT PRIMARY KEY,\
                   parent_id TEXT,\
                   sort_key INTEGER NOT NULL,\
                   title TEXT NOT NULL,\
                   note TEXT NOT NULL,\
                   is_collapsed INTEGER NOT NULL DEFAULT 0,\
                   completed_at TEXT,\
                   deleted_at TEXT\
                 );",
            )
            .expect("create notes table");
        connection
    }

    struct SeedNode<'a> {
        id: &'a str,
        parent_id: Option<&'a str>,
        sort_key: i64,
        title: &'a str,
        note: &'a str,
        is_collapsed: bool,
        completed_at: Option<&'a str>,
        deleted_at: Option<&'a str>,
    }

    impl<'a> SeedNode<'a> {
        fn active(id: &'a str, parent_id: Option<&'a str>, sort_key: i64, title: &'a str) -> Self {
            Self {
                id,
                parent_id,
                sort_key,
                title,
                note: "",
                is_collapsed: false,
                completed_at: None,
                deleted_at: None,
            }
        }
    }

    fn insert_node(connection: &Connection, node: SeedNode<'_>) {
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, is_collapsed, completed_at, deleted_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    node.id,
                    node.parent_id,
                    node.sort_key,
                    node.title,
                    node.note,
                    node.is_collapsed,
                    node.completed_at,
                    node.deleted_at
                ],
            )
            .expect("insert node");
    }

    fn seeded_export_connection() -> Connection {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                note: "Root note",
                is_collapsed: true,
                ..SeedNode::active(ROOT_ID, None, 1024, "Project")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(SECOND_ID, Some(ROOT_ID), 1024, "Second by ID"),
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Supporting note",
                is_collapsed: true,
                completed_at: Some("2026-07-10T00:00:00.000Z"),
                ..SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "First task")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(LATER_ID, Some(ROOT_ID), 2048, "Later task"),
        );
        insert_node(
            &connection,
            SeedNode {
                deleted_at: Some("2026-07-10T01:00:00.000Z"),
                ..SeedNode::active(DELETED_ID, Some(ROOT_ID), 512, "Deleted task")
            },
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Still exported",
                ..SeedNode::active(COLLAPSED_CHILD_ID, Some(FIRST_ID), 1024, "Collapsed child")
            },
        );
        connection
    }

    fn total_changes(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("read total changes")
    }

    #[test]
    fn export_snapshot_keeps_active_sibling_order_content_and_completion_state() {
        let connection = seeded_export_connection();
        let changes_before = total_changes(&connection);

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("snapshot");

        assert_eq!(snapshot.root_node_id, ROOT_ID);
        assert_eq!(snapshot.title, "Project");
        assert_eq!(snapshot.root.id, ROOT_ID);
        assert_eq!(snapshot.root.title, "Project");
        assert_eq!(snapshot.root.note, "Root note");
        assert!(!snapshot.root.completed);
        assert!(snapshot.exported_at.ends_with('Z'));
        assert_eq!(
            snapshot
                .root
                .children
                .iter()
                .map(|child| child.title.as_str())
                .collect::<Vec<_>>(),
            vec!["First task", "Second by ID", "Later task"]
        );
        assert!(snapshot.root.children[0].completed);
        assert_eq!(snapshot.root.children[0].note, "Supporting note");
        assert_eq!(
            snapshot.root.children[0].children[0].title,
            "Collapsed child"
        );
        assert_eq!(total_changes(&connection), changes_before);
    }

    #[test]
    fn export_snapshot_rejects_a_missing_or_deleted_root() {
        let connection = seeded_export_connection();

        let missing = load_export_snapshot(&connection, "77777777-7777-4777-8777-777777777777")
            .expect_err("missing root");
        let deleted = load_export_snapshot(&connection, DELETED_ID).expect_err("deleted root");

        assert!(missing.contains("missing or deleted"));
        assert!(deleted.contains("missing or deleted"));
    }

    #[test]
    fn export_snapshot_rejects_cyclic_tree_corruption() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode::active(ROOT_ID, Some(FIRST_ID), 1024, "Cycle one"),
        );
        insert_node(
            &connection,
            SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "Cycle two"),
        );

        let error = load_export_snapshot(&connection, ROOT_ID).expect_err("cycle");

        assert!(error.contains("cycle"));
    }

    #[test]
    fn markdown_renderer_matches_the_deterministic_frontmatter_and_tree_byte_contract() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "Root note",
            false,
            vec![export_node(FIRST_ID, "First task", "", true, Vec::new())],
        ));

        let rendered = render_markdown(&snapshot);

        assert_eq!(
            rendered,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "# Project\n",
                "\n",
                "- [ ] Project <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  > Root note\n",
                "  - [x] First task <!-- yonalist-node-id: 22222222-2222-4222-8222-222222222222 -->\n",
            )
            .as_bytes()
        );
        assert!(rendered.ends_with(b"\n"));
        assert!(!rendered.ends_with(b"\n\n"));
    }

    #[test]
    fn markdown_renderer_escapes_markdown_and_comment_sensitive_text_consistently() {
        let unsafe_text = r#"A \ *bold* [link](x) #tag <!-- forged --> & done"#;
        let snapshot = snapshot(export_node(
            ROOT_ID,
            unsafe_text,
            unsafe_text,
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot)).expect("UTF-8 Markdown");
        let escaped = r#"A \\ \*bold\* \[link\]\(x\) \#tag &lt;\!\-\- forged \-\-&gt; &amp; done"#;

        assert!(rendered.contains(&format!("# {escaped}\n")));
        assert!(rendered.contains(&format!(
            "- [ ] {escaped} <!-- yonalist-node-id: {ROOT_ID} -->\n"
        )));
        assert!(rendered.contains(&format!("  > {escaped}\n")));
        assert_eq!(rendered.matches("<!--").count(), 1);
        assert_eq!(rendered.matches("-->").count(), 1);
    }

    #[test]
    fn markdown_renderer_normalizes_crlf_and_preserves_blank_multiline_note_lines() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "first\r\n\rsecond\nthird",
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot)).expect("UTF-8 Markdown");

        assert!(rendered.contains("  > first\n  >\n  > second\n  > third\n"));
        assert!(!rendered.contains('\r'));
    }
}
