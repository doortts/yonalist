use serde::{Deserialize, Serialize};

pub type NoteId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub sort_key: i64,
    pub title: String,
    pub note: String,
    pub layout_mode: NoteLayoutMode,
    pub is_collapsed: bool,
    pub is_starred: bool,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteLayoutMode {
    Bullets,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesWorkspace {
    pub nodes: Vec<NoteNode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NotesWorkspaceScope {
    Active,
    Trash,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeInput {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodeInput {
    pub id: NoteId,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodeInput {
    pub id: NoteId,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitNodeInput {
    pub id: NoteId,
    pub new_node_id: NoteId,
    pub prefix: String,
    pub suffix: String,
}

pub(crate) fn validate_note_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    let has_canonical_shape = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());

    if has_canonical_shape {
        Ok(())
    } else {
        Err("Note ID must be a canonical UUID v4 string.".to_string())
    }
}

fn validate_optional_note_id(id: Option<&str>) -> Result<(), String> {
    id.map(validate_note_id).unwrap_or(Ok(()))
}

impl CreateNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        if self.parent_id.as_deref() == Some(self.id.as_str()) {
            return Err("A new node cannot be its own parent.".to_string());
        }
        if self.after_id.as_deref() == Some(self.id.as_str()) {
            return Err("A new node cannot be placed after itself.".to_string());
        }
        Ok(())
    }
}

impl UpdateNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)
    }
}

impl MoveNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_optional_note_id(self.parent_id.as_deref())?;
        validate_optional_note_id(self.after_id.as_deref())?;
        if self.parent_id.as_deref() == Some(self.id.as_str()) {
            return Err("A node cannot be moved under itself.".to_string());
        }
        if self.after_id.as_deref() == Some(self.id.as_str()) {
            return Err("A node cannot be placed after itself.".to_string());
        }
        Ok(())
    }
}

impl SplitNodeInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_note_id(&self.id)?;
        validate_note_id(&self.new_node_id)?;
        if self.id == self.new_node_id {
            return Err("A split node must use a fresh Note ID.".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_note_id;

    #[test]
    fn validates_only_canonical_uuid_v4_ids() {
        assert!(validate_note_id("11111111-1111-4111-8111-111111111111").is_ok());
        assert!(validate_note_id("AAAAAAAA-AAAA-4AAA-BAAA-AAAAAAAAAAAA").is_ok());

        for invalid in [
            "11111111-1111-3111-8111-111111111111",
            "11111111-1111-4111-7111-111111111111",
            "11111111111141118111111111111111",
            "not-a-uuid",
        ] {
            assert!(
                validate_note_id(invalid).is_err(),
                "accepted invalid ID {invalid}"
            );
        }
    }
}
