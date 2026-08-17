use notes_application::StorageError;
use notes_core::{NodeId, NoteImage, NoteMarkerKind, NoteNode, NoteNodeKind};
use rusqlite::Row;

pub(crate) fn parse_node(row: &Row<'_>) -> rusqlite::Result<NoteNode> {
    let id = parse_id(row.get::<_, String>(0)?)?;
    let parent_id = row.get::<_, Option<String>>(1)?.map(parse_id).transpose()?;
    let kind = match row.get::<_, String>(3)?.as_str() {
        "page" => NoteNodeKind::Page,
        "bullet" => NoteNodeKind::Bullet,
        "image" => NoteNodeKind::Image,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("invalid Notes node kind {value}").into(),
            ));
        }
    };
    let marker = match row.get::<_, String>(6)?.as_str() {
        "bullet" => NoteMarkerKind::Bullet,
        "todo" => NoteMarkerKind::Todo,
        "ordered" => NoteMarkerKind::Ordered {
            start: row.get(19)?,
        },
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                format!("invalid Notes marker kind {value}").into(),
            ));
        }
    };
    // Column 12 is not read: the path is derived from the hash, so a row an
    // older build wrote with the vault's own link in it still reads as the
    // picture it always was. A row that cannot make a picture — one still
    // waiting for its bytes, so it has no hash yet — is a node without one
    // rather than a page nobody can open.
    let image = row.get::<_, Option<String>>(11)?.and_then(|content_hash| {
        NoteImage::try_referenced(
            content_hash,
            row.get::<_, String>(13).ok()?,
            row.get::<_, String>(14).ok()?,
            u64::try_from(row.get::<_, i64>(15).ok()?).ok()?,
            row.get::<_, u32>(16).ok()?,
            row.get::<_, u32>(17).ok()?,
            row.get::<_, u32>(18).ok()?,
        )
        .ok()
    });
    Ok(NoteNode::from_persisted_with_image(
        id,
        parent_id,
        row.get(2)?,
        kind,
        image,
        row.get(4)?,
        row.get(5)?,
        marker,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
    ))
}

pub(crate) fn parse_revision(row: &Row<'_>) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(0)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn parse_id(value: String) -> rusqlite::Result<NodeId> {
    NodeId::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

pub(crate) fn kind_name(kind: NoteNodeKind) -> &'static str {
    match kind {
        NoteNodeKind::Page => "page",
        NoteNodeKind::Bullet => "bullet",
        NoteNodeKind::Image => "image",
    }
}

pub(crate) fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_node;
    use rusqlite::Connection;

    const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

    fn open() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory db");
        crate::schema::initialize(&mut connection).expect("schema");
        let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
        notes_sync::hlc::register(&connection, clock).expect("register");
        crate::schema::ensure_root(&mut connection).expect("root");
        connection
    }

    /// The path the row holds and the path the picture has are two different
    /// questions, and only the hash answers the second one.
    fn image_row(connection: &Connection, content_hash: &str, relative_path: &str) {
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                 VALUES ('shot', 'root', 1024, 'image', '')",
                [],
            )
            .expect("node");
        connection
            .execute(
                "INSERT INTO notes_images(node_id, content_hash, relative_path, original_name,
                     mime_type, byte_length, pixel_width, pixel_height, display_width)
                 VALUES ('shot', ?1, ?2, 'holiday.png', 'image/png', 11, 800, 600, 480)",
                rusqlite::params![content_hash, relative_path],
            )
            .expect("image");
    }

    fn read(connection: &Connection) -> notes_core::NoteNode {
        connection
            .query_row(
                "SELECT * FROM notes_node_records WHERE id = 'shot'",
                [],
                parse_node,
            )
            .expect("the row reads")
    }

    #[test]
    fn a_stored_path_from_an_older_build_does_not_decide_the_picture() {
        let connection = open();
        image_row(&connection, HASH, "assets/holiday-9f2c1b7a4e6d.png");

        let image = read(&connection).image().cloned().expect("the picture");

        assert_eq!(image.relative_path(), format!("{HASH}.png"));
        assert_eq!(image.content_hash(), HASH);
        // Asymmetric on purpose: the columns are read by position, and two of
        // them transposed would draw every picture at the wrong shape while
        // every other assertion here still passed.
        assert_eq!(image.pixel_width(), 800);
        assert_eq!(image.pixel_height(), 600);
        assert_eq!(image.display_width(), 480);
        assert_eq!(image.byte_length(), 11);
    }

    #[test]
    fn a_row_still_waiting_for_its_bytes_reads_without_a_picture() {
        let connection = open();
        image_row(&connection, "", "assets/holiday-9f2c1b7a4e6d.png");

        assert!(read(&connection).image().is_none());
    }
}
