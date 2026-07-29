use std::collections::HashMap;
use std::fmt::Write;
use std::path::{Component, Path};
use std::sync::Arc;

use notes_application::{ExportAsset, ExportError, ExportNode, ExportSnapshot, RenderedExport};
use notes_core::NoteNodeKind;

pub(crate) fn render(
    snapshot: &ExportSnapshot,
    asset_directory_name: Option<&str>,
) -> Result<RenderedExport, ExportError> {
    let asset_directory_name = asset_directory_name.ok_or_else(|| {
        ExportError::InvalidDestination("Markdown export requires an asset directory name.".into())
    })?;
    validate_asset_directory_name(asset_directory_name)?;
    validate_node(&snapshot.root)?;

    let mut markdown = render_frontmatter(snapshot);
    if snapshot.root.kind != NoteNodeKind::Image {
        writeln!(markdown, "# {}\n", escape_inline(&snapshot.title))
            .expect("writing to a String cannot fail");
    }
    let mut assets = Vec::new();
    let mut asset_links = HashMap::new();
    render_node(
        &mut markdown,
        &snapshot.root,
        0,
        asset_directory_name,
        &mut asset_links,
        &mut assets,
    )?;
    Ok(RenderedExport::Markdown {
        document: markdown.into_bytes(),
        asset_directory_name: asset_directory_name.into(),
        assets,
    })
}

fn validate_asset_directory_name(value: &str) -> Result<(), ExportError> {
    let components = Path::new(value).components().collect::<Vec<_>>();
    if components.len() != 1
        || !matches!(components[0], Component::Normal(_))
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(ExportError::InvalidDestination(
            "The Notes export asset directory name is unsafe.".into(),
        ));
    }
    Ok(())
}

fn validate_node(node: &ExportNode) -> Result<(), ExportError> {
    match (node.kind, node.image.as_ref()) {
        (NoteNodeKind::Image, Some(image)) if image.bytes.is_some() => {}
        (NoteNodeKind::Image, Some(_)) => {
            return Err(ExportError::Failed(
                "Notes export image bytes were not validated.".into(),
            ));
        }
        (NoteNodeKind::Image, None) => {
            return Err(ExportError::Failed(
                "A Notes image node has no exportable image metadata.".into(),
            ));
        }
        (_, Some(_)) => {
            return Err(ExportError::Failed(
                "A non-image Notes node owns unexpected image metadata.".into(),
            ));
        }
        (_, None) => {}
    }
    if node.id.as_str().contains("--") {
        return Err(ExportError::Failed(
            "A Notes export node ID is unsafe for Markdown metadata.".into(),
        ));
    }
    for child in &node.children {
        validate_node(child)?;
    }
    Ok(())
}

fn render_frontmatter(snapshot: &ExportSnapshot) -> String {
    let mut markdown = String::new();
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes-export").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: 1").expect("writing to a String cannot fail");
    writeln!(markdown, "source: notes.sqlite").expect("writing to a String cannot fail");
    writeln!(
        markdown,
        "root_node_id: \"{}\"",
        escape_yaml_string(snapshot.root_node_id.as_str())
    )
    .expect("writing to a String cannot fail");
    writeln!(
        markdown,
        "exported_at: \"{}\"",
        escape_yaml_string(&snapshot.exported_at)
    )
    .expect("writing to a String cannot fail");
    writeln!(markdown, "---\n").expect("writing to a String cannot fail");
    markdown
}

fn render_node(
    markdown: &mut String,
    node: &ExportNode,
    depth: usize,
    asset_directory_name: &str,
    asset_links: &mut HashMap<String, String>,
    assets: &mut Vec<ExportAsset>,
) -> Result<(), ExportError> {
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    match node.kind {
        NoteNodeKind::Page | NoteNodeKind::Bullet => {
            writeln!(
                markdown,
                "{indentation}- [{completion}] {} <!-- yonalist-node-id: {} -->",
                escape_inline(&node.text),
                node.id
            )
            .expect("writing to a String cannot fail");
        }
        NoteNodeKind::Image => {
            let image = node.image.as_ref().ok_or_else(|| {
                ExportError::Failed("A Notes image node has no image metadata.".into())
            })?;
            let link = image_link(image, asset_directory_name, asset_links, assets)?;
            writeln!(
                markdown,
                "{indentation}- [{completion}] ![Image]({link}) <!-- yonalist-attachment-original-name: {} --> <!-- yonalist-node-id: {} -->",
                percent_encode_comment_metadata(image.metadata.original_name()),
                node.id
            )
            .expect("writing to a String cannot fail");
        }
    }

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
        render_node(
            markdown,
            child,
            depth + 1,
            asset_directory_name,
            asset_links,
            assets,
        )?;
    }
    Ok(())
}

fn image_link(
    image: &notes_application::ExportImage,
    asset_directory_name: &str,
    asset_links: &mut HashMap<String, String>,
    assets: &mut Vec<ExportAsset>,
) -> Result<String, ExportError> {
    let hash = image.metadata.content_hash();
    let file_name = if let Some(file_name) = asset_links.get(hash) {
        file_name.clone()
    } else {
        let ordinal = assets
            .len()
            .checked_add(1)
            .ok_or_else(|| ExportError::TooLarge("Too many export images.".into()))?;
        let extension = match image.metadata.mime_type() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => {
                return Err(ExportError::Failed(
                    "A Notes export image MIME type is unsupported.".into(),
                ));
            }
        };
        let file_name = format!("{ordinal:04}.{extension}");
        assets.push(ExportAsset {
            file_name: file_name.clone(),
            bytes: Arc::clone(image.bytes.as_ref().ok_or_else(|| {
                ExportError::Failed("Notes export image bytes were not validated.".into())
            })?),
        });
        asset_links.insert(hash.into(), file_name.clone());
        file_name
    };
    Ok(format!(
        "{}/{}",
        percent_encode_unreserved(asset_directory_name),
        file_name
    ))
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

fn escape_yaml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn percent_encode_unreserved(value: &str) -> String {
    percent_encode(value, |byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
    })
}

fn percent_encode_comment_metadata(value: &str) -> String {
    percent_encode(value, |byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~')
    })
}

fn percent_encode(value: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if keep(byte) {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}
