use crate::notes::types::NoteTagPrefix;
use std::collections::BTreeMap;
use unicode_general_category::{get_general_category, GeneralCategory};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoteTagToken {
    pub prefix: NoteTagPrefix,
    pub display: String,
    pub normalized: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Debug, Clone, Copy)]
struct Scalar {
    character: char,
    byte_start: usize,
    utf16_start: usize,
}

fn is_mark(character: char) -> bool {
    matches!(
        get_general_category(character),
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

fn is_tag_body_start(character: char) -> bool {
    matches!(character, '_' | '-') || character.is_alphanumeric()
}

fn is_tag_body_continuation(character: char) -> bool {
    is_tag_body_start(character) || is_mark(character)
}

pub(crate) fn is_canonical_tag_body(source: &str) -> bool {
    let mut characters = source.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    is_tag_body_start(first)
        && characters.all(is_tag_body_continuation)
        && source.to_lowercase() == source
}

fn is_ascii_letter(byte: u8) -> bool {
    byte.is_ascii_alphabetic()
}

fn is_ascii_letter_or_digit(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

fn is_url_lead_run_character(byte: u8) -> bool {
    is_ascii_letter_or_digit(byte) || matches!(byte, b'+' | b'-' | b'.')
}

fn is_domain_label(source: &[u8], start: usize, end: usize) -> bool {
    start < end
        && is_ascii_letter_or_digit(source[start])
        && is_ascii_letter_or_digit(source[end - 1])
        && source[start..end]
            .iter()
            .all(|byte| is_ascii_letter_or_digit(*byte) || *byte == b'-')
}

fn is_domain_like_host(source: &[u8], start: usize, end: usize) -> bool {
    let mut label_start = start;
    let mut top_level_start = None;
    for offset in start..end {
        if source[offset] != b'.' {
            continue;
        }
        if !is_domain_label(source, label_start, offset) {
            return false;
        }
        label_start = offset + 1;
        top_level_start = Some(label_start);
    }
    let Some(top_level_start) = top_level_start else {
        return false;
    };
    is_domain_label(source, label_start, end)
        && end.saturating_sub(top_level_start) >= 2
        && source[top_level_start..end]
            .iter()
            .all(|byte| is_ascii_letter(*byte))
}

fn is_opening_url_wrapper(character: char) -> bool {
    matches!(character, '(' | '[' | '{' | '<' | '"' | '\'')
}

fn next_char_boundary(source: &str, offset: usize) -> usize {
    offset
        + source[offset..]
            .chars()
            .next()
            .expect("offset is inside source")
            .len_utf8()
}

fn find_url_evidence_end(source: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut relative_start = start;
    while relative_start < end {
        let character = source[relative_start..]
            .chars()
            .next()
            .expect("segment character");
        if !is_opening_url_wrapper(character) {
            break;
        }
        relative_start += character.len_utf8();
    }

    let relative = &source[relative_start..end];
    if relative.starts_with('/') || relative.starts_with("./") || relative.starts_with("../") {
        return Some(relative_start);
    }

    let mut offset = start;
    while offset < end {
        let byte = bytes[offset];
        if !is_ascii_letter_or_digit(byte) {
            offset = next_char_boundary(source, offset);
            continue;
        }

        let run_start = offset;
        offset += 1;
        while offset < end && is_url_lead_run_character(bytes[offset]) {
            offset += 1;
        }
        let run_end = offset;

        if is_ascii_letter(bytes[run_start])
            && run_end + 3 <= end
            && bytes.get(run_end..run_end + 3) == Some(b"://")
        {
            return Some(run_end + 3);
        }
        if run_end - run_start > 4 && source[run_start..run_start + 4].eq_ignore_ascii_case("www.")
        {
            return Some(run_start + 4);
        }
        let next = bytes.get(run_end).copied();
        if is_domain_like_host(bytes, run_start, run_end)
            && matches!(next, Some(b'/' | b'?' | b'#' | b':'))
        {
            return Some(run_end);
        }
    }
    None
}

pub(crate) fn tokenize_note_text(source: &str) -> Vec<NoteTagToken> {
    let mut utf16_start = 0;
    let scalars = source
        .char_indices()
        .map(|(byte_start, character)| {
            let scalar = Scalar {
                character,
                byte_start,
                utf16_start,
            };
            utf16_start += character.len_utf16();
            scalar
        })
        .collect::<Vec<_>>();
    let total_utf16 = utf16_start;
    let mut tags = Vec::new();
    let mut index = 0;
    let mut segment_end = 0;
    let mut url_evidence_end = None;

    while index < scalars.len() {
        let scalar = scalars[index];
        if scalar.byte_start >= segment_end {
            if scalar.character.is_whitespace() {
                segment_end = scalar.byte_start + scalar.character.len_utf8();
                url_evidence_end = None;
            } else {
                let mut segment_end_index = index + 1;
                while segment_end_index < scalars.len()
                    && !scalars[segment_end_index].character.is_whitespace()
                {
                    segment_end_index += 1;
                }
                segment_end = scalars
                    .get(segment_end_index)
                    .map_or(source.len(), |next| next.byte_start);
                url_evidence_end = find_url_evidence_end(source, scalar.byte_start, segment_end);
            }
        }

        let prefix = match scalar.character {
            '#' => Some(NoteTagPrefix::Hash),
            '@' => Some(NoteTagPrefix::Mention),
            _ => None,
        };
        let invalid_boundary = index > 0
            && (is_tag_body_continuation(scalars[index - 1].character)
                || matches!(scalars[index - 1].character, '/' | '#' | '@'));
        if prefix.is_none()
            || url_evidence_end.is_some_and(|evidence| scalar.byte_start >= evidence)
            || invalid_boundary
        {
            index += 1;
            continue;
        }

        let body_start = index + 1;
        if body_start >= scalars.len() || !is_tag_body_start(scalars[body_start].character) {
            index += 1;
            continue;
        }
        let mut body_end = body_start + 1;
        while body_end < scalars.len() && is_tag_body_continuation(scalars[body_end].character) {
            body_end += 1;
        }

        let body_start_byte = scalars[body_start].byte_start;
        let body_end_byte = scalars
            .get(body_end)
            .map_or(source.len(), |next| next.byte_start);
        let display = source[body_start_byte..body_end_byte].to_string();
        tags.push(NoteTagToken {
            prefix: prefix.expect("tag prefix"),
            normalized: display.to_lowercase(),
            display,
            start_utf16: scalar.utf16_start,
            end_utf16: scalars
                .get(body_end)
                .map_or(total_utf16, |next| next.utf16_start),
        });
        index = body_end;
    }
    tags
}

pub(crate) fn extract_note_tags(
    title: &str,
    note: &str,
) -> BTreeMap<(NoteTagPrefix, String), String> {
    let mut tags = BTreeMap::new();
    for text in [title, note] {
        for token in tokenize_note_text(text) {
            tags.entry((token.prefix, token.normalized))
                .or_insert(token.display);
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::{is_canonical_tag_body, tokenize_note_text};
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        source: String,
        tags: Vec<ExpectedTag>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedTag {
        prefix: String,
        display: String,
        normalized: String,
        start_utf16: usize,
        end_utf16: usize,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TagFilterFixture {
        normalized_tag: String,
        valid: bool,
    }

    #[test]
    fn notes_tag_filter_body_matches_shared_typescript_fixtures() {
        let fixtures: Vec<TagFilterFixture> = serde_json::from_str(include_str!(
            "../../../src/features/notes/noteTagFilter.fixtures.json"
        ))
        .expect("shared tag filter fixtures");

        for fixture in fixtures {
            assert_eq!(
                is_canonical_tag_body(&fixture.normalized_tag),
                fixture.valid,
                "normalizedTag: {:?}",
                fixture.normalized_tag
            );
        }
    }

    #[test]
    fn notes_tag_tokenizer_matches_shared_typescript_fixtures() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../../src/features/notes/noteTokenizer.fixtures.json"
        ))
        .expect("shared tokenizer fixtures");

        for fixture in fixtures {
            let actual = tokenize_note_text(&fixture.source)
                .into_iter()
                .map(|tag| ExpectedTag {
                    prefix: tag.prefix.as_str().to_string(),
                    display: tag.display,
                    normalized: tag.normalized,
                    start_utf16: tag.start_utf16,
                    end_utf16: tag.end_utf16,
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, fixture.tags, "source: {:?}", fixture.source);
        }
    }
}
