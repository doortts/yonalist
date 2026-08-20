use notes_application::{
    CommandEnvelope, ForestRequest, IpcNotesCommand, NotesService, SearchQuery, StorageError,
    ViewportRequest,
};
use notes_sqlite::SqliteStorage;

fn execute(
    service: &NotesService<&SqliteStorage>,
    request_id: &str,
    revision: u64,
    command: IpcNotesCommand,
) {
    service
        .execute(CommandEnvelope {
            session_id: "session".into(),
            request_id: request_id.into(),
            base_revision: revision,
            history_group: None,
            command,
        })
        .unwrap();
}

/// Pages are root children now, so "create a page" is an ordinary child
/// creation under the root row.
fn create_page(service: &NotesService<&SqliteStorage>, revision: u64, id: &str, text: &str) {
    execute(
        service,
        id,
        revision,
        IpcNotesCommand::CreateNode {
            id: id.into(),
            parent_id: "root".into(),
            before_id: None,
            text: text.into(),
        },
    );
}

#[test]
fn the_root_viewport_is_the_whole_forest_and_still_paginates() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page-a", "Inbox");
    execute(
        &service,
        "child",
        1,
        IpcNotesCommand::CreateNode {
            id: "child".into(),
            parent_id: "page-a".into(),
            before_id: None,
            text: "Task".into(),
        },
    );
    create_page(&service, 2, "page-b", "Later");

    let whole = storage
        .query_viewport(ViewportRequest {
            page_id: "root".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(
        whole
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["page-a", "child", "page-b"]
    );

    let first = storage
        .query_viewport(ViewportRequest {
            page_id: "root".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(first.nodes.len(), 2);
    let rest = storage
        .query_viewport(ViewportRequest {
            page_id: "root".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: first.after_cursor,
            limit: 2,
        })
        .unwrap();
    assert_eq!(
        rest.nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["page-b"]
    );
}

#[test]
fn a_page_is_an_ordinary_node_so_its_own_viewport_still_opens() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page", "Inbox");
    execute(
        &service,
        "child",
        1,
        IpcNotesCommand::CreateNode {
            id: "child".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "Task".into(),
        },
    );
    execute(
        &service,
        "grandchild",
        2,
        IpcNotesCommand::CreateNode {
            id: "grandchild".into(),
            parent_id: "child".into(),
            before_id: None,
            text: "Detail".into(),
        },
    );

    let page = storage
        .query_viewport(ViewportRequest {
            page_id: "page".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();

    assert_eq!(
        page.nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["child", "grandchild"]
    );
}

#[test]
fn bootstrap_pages_are_the_live_root_children_in_order() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "z-first", "First");
    create_page(&service, 1, "a-second", "Second");
    create_page(&service, 2, "trashed", "Gone");
    execute(
        &service,
        "trash",
        3,
        IpcNotesCommand::DeleteSubtree {
            id: "trashed".into(),
        },
    );

    let boot = storage.bootstrap("session-b", 20).unwrap();

    assert_eq!(
        boot.pages
            .iter()
            .map(|page| (page.id.as_str(), page.title.as_str()))
            .collect::<Vec<_>>(),
        vec![("z-first", "First"), ("a-second", "Second")]
    );
    assert!(boot.pages[0].sort_key < boot.pages[1].sort_key);
}

#[test]
fn bootstrap_keeps_home_and_falls_back_to_it_when_the_page_is_gone() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page", "Inbox");

    let fresh = storage.bootstrap("session-a", 20).unwrap();
    assert_eq!(fresh.active_page_id.as_deref(), Some("root"));

    storage
        .query_viewport(ViewportRequest {
            page_id: "root".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(
        storage
            .bootstrap("session-b", 20)
            .unwrap()
            .active_page_id
            .as_deref(),
        Some("root")
    );

    storage
        .query_viewport(ViewportRequest {
            page_id: "page".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();
    execute(
        &service,
        "trash",
        1,
        IpcNotesCommand::DeleteSubtree { id: "page".into() },
    );

    let orphaned = storage.bootstrap("session-c", 20).unwrap();
    assert_eq!(orphaned.active_page_id.as_deref(), Some("root"));
}

#[test]
fn a_search_hit_names_the_page_it_lives_under_not_the_root() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page", "Inbox alpha");
    execute(
        &service,
        "child",
        1,
        IpcNotesCommand::CreateNode {
            id: "child".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "middle".into(),
        },
    );
    execute(
        &service,
        "grandchild",
        2,
        IpcNotesCommand::CreateNode {
            id: "grandchild".into(),
            parent_id: "child".into(),
            before_id: None,
            text: "buried alpha".into(),
        },
    );

    let hits = storage
        .search(SearchQuery {
            text: "alpha".into(),
            cursor: None,
            limit: 20,
        })
        .unwrap()
        .hits;

    let owners = hits
        .iter()
        .map(|hit| (hit.node.id.as_str(), hit.page_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(owners.len(), 2, "{owners:?}");
    assert!(owners.contains(&("grandchild", "page")), "{owners:?}");
    assert!(owners.contains(&("page", "page")), "{owners:?}");
}

/// The root row carries the word "Home", and it is a row in the FTS index like
/// any other. It is not a hit anyone can open, so it stays out of the results.
#[test]
fn the_root_row_never_shows_up_as_a_search_hit() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page", "Home away from home");

    let hits = storage
        .search(SearchQuery {
            text: "home".into(),
            cursor: None,
            limit: 20,
        })
        .unwrap()
        .hits;

    assert_eq!(
        hits.iter()
            .map(|hit| hit.node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["page"]
    );
}

#[test]
fn bootstrap_and_viewport_are_bounded_and_cursor_revisioned() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "page-a",
        0,
        IpcNotesCommand::CreateNode {
            id: "page-a".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Inbox".into(),
        },
    );
    execute(
        &service,
        "page-b",
        1,
        IpcNotesCommand::CreateNode {
            id: "page-b".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Later".into(),
        },
    );
    for index in 0..5 {
        execute(
            &service,
            &format!("node-{index}"),
            2 + index,
            IpcNotesCommand::CreateNode {
                id: format!("node-{index}"),
                parent_id: "page-a".into(),
                before_id: None,
                text: format!("Task {index}"),
            },
        );
    }

    let boot = storage.bootstrap("new-session", 3).unwrap();
    assert_eq!(boot.session_id, "new-session");
    assert_eq!(boot.revision, 7);
    assert_eq!(boot.pages.len(), 2);
    // Nothing was ever opened, so bootstrap lands on Home and bounds it too.
    assert_eq!(boot.active_page_id.as_deref(), Some("root"));
    let home = boot.viewport.unwrap();
    assert_eq!(home.page_id, "root");
    assert_eq!(home.nodes.len(), 3);

    let initial = storage
        .query_viewport(ViewportRequest {
            page_id: "page-a".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 3,
        })
        .unwrap();
    assert_eq!(initial.nodes.len(), 3);
    assert!(initial.before_cursor.is_none());
    assert!(initial.after_cursor.is_some());

    let next = storage
        .query_viewport(ViewportRequest {
            page_id: "page-a".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: initial.after_cursor,
            limit: 3,
        })
        .unwrap();
    assert_eq!(
        next.nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["node-3", "node-4"]
    );
    assert!(next.after_cursor.is_none());

    let stale = storage
        .query_viewport(ViewportRequest {
            page_id: "page-a".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: Some("r:1:o:3".into()),
            limit: 3,
        })
        .unwrap_err();
    assert!(matches!(
        stale,
        StorageError::RevisionConflict {
            expected: 1,
            actual: 7
        }
    ));
}

#[test]
fn forest_query_returns_authoritative_preorder_and_reports_its_bound() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "page",
        0,
        IpcNotesCommand::CreateNode {
            id: "page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Page".into(),
        },
    );
    for (request_id, revision, id, parent_id) in [
        ("branch", 1, "branch", "page"),
        ("child", 2, "child", "branch"),
        ("grandchild", 3, "grandchild", "child"),
        ("sibling", 4, "sibling", "page"),
    ] {
        execute(
            &service,
            request_id,
            revision,
            IpcNotesCommand::CreateNode {
                id: id.into(),
                parent_id: parent_id.into(),
                before_id: None,
                text: id.into(),
            },
        );
    }

    let complete = storage
        .query_forest(ForestRequest {
            root_ids: vec!["branch".into()],
            limit: 10,
        })
        .unwrap();
    assert_eq!(complete.revision, 5);
    assert!(complete.complete);
    assert_eq!(
        complete
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["branch", "child", "grandchild"]
    );

    let bounded = storage
        .query_forest(ForestRequest {
            root_ids: vec!["branch".into()],
            limit: 2,
        })
        .unwrap();
    assert!(!bounded.complete);
    assert_eq!(bounded.nodes.len(), 2);
}

#[test]
fn querying_a_page_makes_it_the_next_bootstrap_page() {
    let storage = SqliteStorage::open_in_memory().expect("open sqlite");
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "first-page",
        0,
        IpcNotesCommand::CreateNode {
            id: "first-page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "First".into(),
        },
    );
    execute(
        &service,
        "second-page",
        1,
        IpcNotesCommand::CreateNode {
            id: "second-page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Second".into(),
        },
    );

    storage
        .query_viewport(ViewportRequest {
            page_id: "second-page".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .expect("open the second page");

    let boot = storage.bootstrap("session-b", 20).expect("bootstrap");
    assert_eq!(boot.active_page_id.as_deref(), Some("second-page"));
    assert_eq!(boot.revision, 2);
}

#[test]
fn page_navigation_preserves_creation_order_when_ids_sort_differently() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "z-first",
        0,
        IpcNotesCommand::CreateNode {
            id: "z-first".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "First".into(),
        },
    );
    execute(
        &service,
        "a-second",
        1,
        IpcNotesCommand::CreateNode {
            id: "a-second".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Second".into(),
        },
    );

    let boot = storage.bootstrap("next-session", 20).unwrap();
    assert_eq!(
        boot.pages
            .iter()
            .map(|page| page.id.as_str())
            .collect::<Vec<_>>(),
        vec!["z-first", "a-second"]
    );
}

#[test]
fn viewport_preserves_numeric_order_after_repeated_prepends_create_negative_keys() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "page",
        0,
        IpcNotesCommand::CreateNode {
            id: "page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Inbox".into(),
        },
    );
    execute(
        &service,
        "original",
        1,
        IpcNotesCommand::CreateNode {
            id: "original".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "Original".into(),
        },
    );
    let mut first_id = "original".to_owned();
    for index in 0..3 {
        let id = format!("prepend-{index}");
        execute(
            &service,
            &id,
            2 + index,
            IpcNotesCommand::CreateNode {
                id: id.clone(),
                parent_id: "page".into(),
                before_id: Some(first_id),
                text: format!("Prepended {index}"),
            },
        );
        first_id = id;
    }

    let viewport = storage
        .query_viewport(ViewportRequest {
            page_id: "page".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();

    assert_eq!(
        viewport
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["prepend-2", "prepend-1", "prepend-0", "original"]
    );
}

#[test]
fn fts_search_tracks_text_updates_without_loading_the_workspace() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "page",
        0,
        IpcNotesCommand::CreateNode {
            id: "page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Inbox".into(),
        },
    );
    execute(
        &service,
        "node",
        1,
        IpcNotesCommand::CreateNode {
            id: "node".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "alpha launch".into(),
        },
    );

    let first = storage
        .search(SearchQuery {
            text: "alpha".into(),
            cursor: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(first.hits.len(), 1);
    assert_eq!(first.hits[0].page_id, "page");

    execute(
        &service,
        "edit",
        2,
        IpcNotesCommand::UpdateText {
            id: "node".into(),
            text: "beta launch".into(),
        },
    );
    assert!(
        storage
            .search(SearchQuery {
                text: "alpha".into(),
                cursor: None,
                limit: 20,
            })
            .unwrap()
            .hits
            .is_empty()
    );
    assert_eq!(
        storage
            .search(SearchQuery {
                text: "beta".into(),
                cursor: None,
                limit: 20,
            })
            .unwrap()
            .hits
            .len(),
        1
    );
}

#[test]
fn search_filters_starred_trash_tags_and_dates_without_a_workspace_load() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    execute(
        &service,
        "page",
        0,
        IpcNotesCommand::CreateNode {
            id: "page".into(),
            parent_id: "root".into(),
            before_id: None,
            text: "Inbox".into(),
        },
    );
    execute(
        &service,
        "active",
        1,
        IpcNotesCommand::CreateNode {
            id: "active".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "#alpha review on 2026-07-27, not 2026-02-31".into(),
        },
    );
    execute(
        &service,
        "star",
        2,
        IpcNotesCommand::SetStarred {
            id: "active".into(),
            starred: true,
        },
    );
    execute(
        &service,
        "deleted",
        3,
        IpcNotesCommand::CreateNode {
            id: "deleted".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "Discarded".into(),
        },
    );
    execute(
        &service,
        "trash",
        4,
        IpcNotesCommand::DeleteSubtree {
            id: "deleted".into(),
        },
    );

    for (filter, expected) in [
        ("is:starred", "active"),
        ("is:trash", "deleted"),
        ("is:tagged", "active"),
        ("tag:#alpha", "active"),
        ("date:2026-07-27", "active"),
    ] {
        let page = storage
            .search(SearchQuery {
                text: filter.into(),
                cursor: None,
                limit: 20,
            })
            .unwrap();
        assert_eq!(page.hits.len(), 1, "{filter}");
        assert_eq!(page.hits[0].node.id, expected, "{filter}");
    }
    assert!(
        storage
            .search(SearchQuery {
                text: "date:2026-02-31".into(),
                cursor: None,
                limit: 20,
            })
            .unwrap()
            .hits
            .is_empty()
    );
}

#[test]
fn a_date_search_takes_a_range_as_well_as_a_day() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page", "Inbox");
    execute(
        &service,
        "july",
        1,
        IpcNotesCommand::CreateNode {
            id: "july".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "retro on 2026-07-27".into(),
        },
    );
    execute(
        &service,
        "august",
        2,
        IpcNotesCommand::CreateNode {
            id: "august".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "release on 2026-08-24".into(),
        },
    );

    let hits = |query: &str| {
        storage
            .search(SearchQuery {
                text: query.into(),
                cursor: None,
                limit: 20,
            })
            .unwrap()
            .hits
            .into_iter()
            .map(|hit| hit.node.id)
            .collect::<Vec<_>>()
    };

    assert_eq!(hits("date:2026-07-01..2026-07-31"), vec!["july".to_owned()]);
    assert_eq!(
        hits("date:2026-07-01..2026-08-31"),
        vec!["july".to_owned(), "august".to_owned()]
    );
    assert!(hits("date:2026-09-01..2026-09-30").is_empty());
    // Written back to front, and read as the range it plainly means.
    assert_eq!(hits("date:2026-07-31..2026-07-01"), vec!["july".to_owned()]);
    // Both ends have to be dates. A half-written range is not one, and falls
    // through to the single-day filter -- which no row's date matches, since
    // no date_key carries a `..`.
    assert!(hits("date:2026-07-01..").is_empty());
    assert!(hits("date:..2026-07-31").is_empty());

    // A filter's own values are bound after the fixed ones, so the page window
    // has to still be the window: with the limit and the offset transposed this
    // asks for one row and gets none, or gets both.
    let first = storage
        .search(SearchQuery {
            text: "date:2026-07-01..2026-08-31".into(),
            cursor: None,
            limit: 1,
        })
        .unwrap();
    assert_eq!(
        first
            .hits
            .iter()
            .map(|hit| hit.node.id.clone())
            .collect::<Vec<_>>(),
        vec!["july".to_owned()]
    );
    let second = storage
        .search(SearchQuery {
            text: "date:2026-07-01..2026-08-31".into(),
            cursor: first.next_cursor,
            limit: 1,
        })
        .unwrap();
    assert_eq!(
        second
            .hits
            .iter()
            .map(|hit| hit.node.id.clone())
            .collect::<Vec<_>>(),
        vec!["august".to_owned()]
    );
}

#[test]
fn a_viewport_carries_the_page_node_the_body_listing_leaves_out() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    create_page(&service, 0, "page-a", "Inbox");
    execute(
        &service,
        "child",
        1,
        IpcNotesCommand::CreateNode {
            id: "child".into(),
            parent_id: "page-a".into(),
            before_id: None,
            text: "Task".into(),
        },
    );
    execute(
        &service,
        "note",
        2,
        IpcNotesCommand::UpdateNote {
            id: "page-a".into(),
            note: "Page context".into(),
        },
    );

    let page = storage
        .query_viewport(ViewportRequest {
            page_id: "page-a".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();
    let page_node = page.page_node.expect("the page's own node");
    assert_eq!(page_node.id, "page-a");
    assert_eq!(page_node.note, "Page context");
    assert_eq!(
        page.nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["child"]
    );

    let root = storage
        .query_viewport(ViewportRequest {
            page_id: "root".into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(root.page_node.map(|node| node.id).as_deref(), Some("root"));
}

#[test]
fn the_page_list_is_every_live_root_child_however_deep_the_first_page_runs() {
    // The page list used to be read off the root's viewport window, which
    // carries the whole forest depth first and stops at its row limit: more
    // pages than that limit, or one busy page ahead of them, was enough to
    // push the rest out of the sidebar.
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    let mut revision = 0;
    for index in 0..90 {
        create_page(
            &service,
            revision,
            &format!("page-{index:02}"),
            &format!("Page {index}"),
        );
        revision += 1;
    }
    execute(
        &service,
        "child",
        revision,
        IpcNotesCommand::CreateNode {
            id: "child".into(),
            parent_id: "page-00".into(),
            before_id: None,
            text: "Task".into(),
        },
    );
    revision += 1;
    create_page(&service, revision, "trashed", "Gone");
    revision += 1;
    execute(
        &service,
        "trash",
        revision,
        IpcNotesCommand::DeleteSubtree {
            id: "trashed".into(),
        },
    );

    let pages = storage.pages().unwrap();

    assert_eq!(
        pages
            .iter()
            .map(|page| page.id.as_str())
            .collect::<Vec<_>>(),
        (0..90)
            .map(|index| format!("page-{index:02}"))
            .collect::<Vec<_>>()
    );
}
