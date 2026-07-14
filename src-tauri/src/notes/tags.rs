use crate::notes::types::{NoteSearchTag, NoteTagFilter, NoteTagPrefix};
use std::collections::BTreeMap;
use unicode_general_category::{get_general_category, GeneralCategory};
use unicode_normalization::{is_nfc, UnicodeNormalization};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoteTagToken {
    pub prefix: NoteTagPrefix,
    pub display: String,
    pub normalized: String,
    pub start_byte: usize,
    pub end_byte: usize,
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
        // Canonical tag bodies are NFC: macOS routinely emits NFD (decomposed)
        // Hangul/accented text, so a decomposed spelling is not canonical even
        // though its scalars all pass the body checks above.
        && is_nfc(source)
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
        // Normalize the derived tag VALUE to NFC so decomposed (NFD) and composed
        // spellings of the same tag unify. The UTF-16 offsets below still index the
        // ORIGINAL source, which may differ in length from the normalized value.
        let display = source[body_start_byte..body_end_byte]
            .nfc()
            .collect::<String>();
        tags.push(NoteTagToken {
            prefix: prefix.expect("tag prefix"),
            normalized: display.to_lowercase(),
            display,
            start_byte: scalar.byte_start,
            end_byte: body_end_byte,
            start_utf16: scalar.utf16_start,
            end_utf16: scalars
                .get(body_end)
                .map_or(total_utf16, |next| next.utf16_start),
        });
        index = body_end;
    }
    tags
}

fn has_exact_tag(source: &str, tag: &NoteTagFilter) -> bool {
    tokenize_note_text(source)
        .into_iter()
        .any(|token| token.prefix == tag.prefix && token.normalized == tag.normalized_tag)
}

/// Appends the submitted display spelling to the title when neither content
/// field already contains the same tokenizer identity. `display_tag` is a body,
/// not a complete token; the persisted token is the submitted prefix plus that
/// body, byte-for-byte.
pub(crate) fn add_exact_tag_to_title(
    title: &str,
    note: &str,
    tag: &NoteSearchTag,
) -> Result<Option<String>, String> {
    let persisted_token = format!("{}{}", tag.prefix.as_str(), tag.display_tag);
    let tokens = tokenize_note_text(&persisted_token);
    let valid = matches!(tokens.as_slice(), [token]
        if token.start_byte == 0
            && token.end_byte == persisted_token.len()
            && token.prefix == tag.prefix
            && token.normalized == tag.normalized_tag);
    if !valid {
        return Err(
            "Batch tag displayTag must form exactly one complete tag token matching prefix and normalizedTag."
                .to_string(),
        );
    }

    let identity = NoteTagFilter {
        prefix: tag.prefix,
        normalized_tag: tag.normalized_tag.clone(),
    };
    if has_exact_tag(title, &identity) || has_exact_tag(note, &identity) {
        return Ok(None);
    }

    Ok(Some(if title.is_empty() {
        persisted_token
    } else {
        format!("{title} {persisted_token}")
    }))
}

fn remove_exact_tag_tokens_once(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let bytes = source.as_bytes();
    let ranges = tokenize_note_text(source)
        .into_iter()
        .filter(|token| token.prefix == tag.prefix && token.normalized == tag.normalized_tag)
        .map(|token| {
            let mut start = token.start_byte;
            let mut end = token.end_byte;
            if start > 0 && bytes[start - 1] == b' ' {
                start -= 1;
            } else if end < bytes.len() && bytes[end] == b' ' {
                end += 1;
            }
            (start, end)
        })
        .collect::<Vec<_>>();
    if ranges.is_empty() {
        return None;
    }

    let mut result = String::with_capacity(source.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        if start > cursor {
            result.push_str(&source[cursor..start]);
        }
        cursor = cursor.max(end);
    }
    result.push_str(&source[cursor..]);
    Some(result)
}

/// Removes every tokenizer-exact occurrence and, for each occurrence, consumes
/// one immediately preceding ASCII space when present or otherwise one
/// immediately following ASCII space. All ranges are UTF-8 byte ranges derived
/// alongside the tokenizer's UTF-16 display offsets.
pub(crate) fn remove_exact_tag_tokens(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let mut result = remove_exact_tag_tokens_once(source, tag)?;
    // A deletion can expose a marker that was not a token in the original
    // source (`#x#x` -> `#x`). Continue to the tokenizer's fixed point so a
    // successful RemoveTag is idempotent while every pass still honors the
    // canonical boundary, URL, prefix, and normalized-identity rules.
    while let Some(next) = remove_exact_tag_tokens_once(&result, tag) {
        debug_assert!(next.len() < result.len());
        result = next;
    }
    Some(result)
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
    use super::{
        add_exact_tag_to_title, is_canonical_tag_body, is_nfc, remove_exact_tag_tokens,
        tokenize_note_text,
    };
    use crate::notes::types::{NoteSearchTag, NoteTagFilter, NoteTagPrefix};
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
    fn notes_tag_tokenizer_unifies_decomposed_and_composed_tags() {
        // macOS drag/paste/IME text arrives decomposed (NFD); deriving a tag from it
        // must equal deriving from the composed (NFC) spelling of the same tag.
        for (decomposed, composed) in [
            ("#cafe\u{0301}", "#caf\u{e9}"),
            (
                "#\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}",
                "#\u{d55c}\u{ae00}",
            ),
        ] {
            let from_decomposed = tokenize_note_text(decomposed);
            let from_composed = tokenize_note_text(composed);
            assert_eq!(
                from_decomposed.len(),
                1,
                "decomposed source: {decomposed:?}"
            );
            assert_eq!(from_composed.len(), 1, "composed source: {composed:?}");

            let decomposed_tag = &from_decomposed[0];
            let composed_tag = &from_composed[0];
            assert_eq!(decomposed_tag.display, composed_tag.display);
            assert_eq!(decomposed_tag.normalized, composed_tag.normalized);
            // The derived value is composed even though the source was decomposed.
            assert_eq!(decomposed_tag.display, composed[1..]);
            assert!(is_nfc(&decomposed_tag.display));
            // Offsets still index the ORIGINAL (decomposed) source, so they span the
            // longer NFD scalar run rather than the composed length.
            assert_eq!(decomposed_tag.start_utf16, 0);
            assert_eq!(decomposed_tag.end_utf16, decomposed.encode_utf16().count());
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

    fn hash_tag(normalized_tag: &str) -> NoteTagFilter {
        NoteTagFilter {
            prefix: NoteTagPrefix::Hash,
            normalized_tag: normalized_tag.to_string(),
        }
    }

    fn search_tag(prefix: NoteTagPrefix, normalized_tag: &str, display_tag: &str) -> NoteSearchTag {
        NoteSearchTag {
            prefix,
            normalized_tag: normalized_tag.to_string(),
            display_tag: display_tag.to_string(),
        }
    }

    #[test]
    fn batch_tag_remove_matches_exact_prefix_and_normalized_identity_only() {
        let source = concat!(
            "#ROADMAP @Roadmap #roadmaps road#roadmap /#roadmap ##roadmap ",
            "https://x.test/?q=#roadmap #Roadmap,#other"
        );

        assert_eq!(
            remove_exact_tag_tokens(source, &hash_tag("roadmap")),
            Some(
                concat!(
                    "@Roadmap #roadmaps road#roadmap /#roadmap ##roadmap ",
                    "https://x.test/?q=#roadmap,#other"
                )
                .to_string()
            )
        );
    }

    #[test]
    fn batch_tag_remove_unifies_nfc_and_decomposed_unicode_without_byte_corruption() {
        let source = "앞 #CAFE\u{301} 뒤 #café, 한글 #프로젝트 끝 #cafe\u{301}";

        assert_eq!(
            remove_exact_tag_tokens(source, &hash_tag("café")),
            Some("앞 뒤, 한글 #프로젝트 끝".to_string())
        );
    }

    #[test]
    fn batch_tag_remove_deletes_every_occurrence_and_only_one_adjacent_ascii_space() {
        let tag = hash_tag("x");
        for (source, expected) in [
            ("left #x right", "left right"),
            ("#x right", "right"),
            ("left:#x right", "left:right"),
            ("left  #x  right", "left   right"),
            ("#x #X #x", ""),
            ("(#x),[#X];", "(),[];"),
            ("left\t#x\nright", "left\t\nright"),
        ] {
            assert_eq!(
                remove_exact_tag_tokens(source, &tag),
                Some(expected.to_string()),
                "source: {source:?}"
            );
        }
        assert_eq!(remove_exact_tag_tokens("plain #xy @x", &tag), None);
    }

    #[test]
    fn batch_tag_remove_is_idempotent_when_one_deletion_exposes_another_exact_token() {
        let tag = hash_tag("x");

        for (source, expected) in [
            ("#x#x", ""),
            ("#x#X", ""),
            ("#x#xy", "#xy"),
            ("a #x#x", "a#x"),
        ] {
            let removed = remove_exact_tag_tokens(source, &tag);
            assert_eq!(removed, Some(expected.to_string()), "source: {source:?}");
            assert_eq!(
                remove_exact_tag_tokens(removed.as_deref().expect("changed source"), &tag),
                None,
                "result was not idempotent for source: {source:?}"
            );
        }
    }

    #[test]
    fn batch_tag_add_preserves_display_body_and_checks_both_content_fields() {
        let tag = search_tag(NoteTagPrefix::Hash, "café", "CAFE\u{301}");

        assert_eq!(
            add_exact_tag_to_title("Plan", "", &tag).expect("valid display tag"),
            Some("Plan #CAFE\u{301}".to_string())
        );
        assert_eq!(
            add_exact_tag_to_title("", "", &tag).expect("valid empty title append"),
            Some("#CAFE\u{301}".to_string())
        );
        assert_eq!(
            add_exact_tag_to_title("Plan #CAFÉ", "", &tag).expect("title identity"),
            None
        );
        assert_eq!(
            add_exact_tag_to_title("Plan", "support #cafe\u{301}", &tag)
                .expect("supporting-note identity"),
            None
        );
        assert_eq!(
            add_exact_tag_to_title("Plan @café", "", &tag).expect("prefix distinction"),
            Some("Plan @café #CAFE\u{301}".to_string())
        );
    }

    #[test]
    fn batch_tag_add_rejects_display_text_that_is_not_one_full_matching_token() {
        for tag in [
            search_tag(NoteTagPrefix::Hash, "roadmap", ""),
            search_tag(NoteTagPrefix::Hash, "roadmap", "Roadmap more"),
            search_tag(NoteTagPrefix::Hash, "roadmap", "Roadmap.more"),
            search_tag(NoteTagPrefix::Hash, "roadmap", "Roadmap #other"),
            search_tag(NoteTagPrefix::Hash, "roadmap", "#Roadmap"),
            search_tag(NoteTagPrefix::Hash, "different", "Roadmap"),
        ] {
            let error = add_exact_tag_to_title("Plan", "", &tag)
                .expect_err("invalid display token must be rejected");
            assert!(error.contains("displayTag"), "unexpected error: {error}");
        }
    }
}
