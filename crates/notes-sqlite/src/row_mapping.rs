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
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                format!("invalid Notes marker kind {value}").into(),
            ));
        }
    };
    let content_hash = row.get::<_, Option<String>>(11)?;
    let image = content_hash
        .map(|content_hash| {
            NoteImage::try_new(
                content_hash,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                u64::try_from(row.get::<_, i64>(15)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        15,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?,
                row.get::<_, u32>(16)?,
                row.get::<_, u32>(17)?,
                row.get::<_, u32>(18)?,
            )
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    11,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
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
