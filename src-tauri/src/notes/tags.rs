use crate::notes::types::{NoteSearchTag, NoteTagFilter, NoteTagPrefix};
use icu_casemap::CaseMapper;
#[cfg(test)]
use std::cell::Cell;
use std::collections::BTreeMap;
use unicode_normalization::{is_nfc, UnicodeNormalization};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

#[cfg(test)]
thread_local! {
    static REMOVE_EXACT_TAG_SCAN_WORK: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
fn record_remove_exact_tag_scan_work(work: usize) {
    REMOVE_EXACT_TAG_SCAN_WORK.with(|total| total.set(total.get() + work));
}

#[cfg(test)]
fn reset_remove_exact_tag_scan_work() {
    REMOVE_EXACT_TAG_SCAN_WORK.with(|total| total.set(0));
}

#[cfg(test)]
fn remove_exact_tag_scan_work() -> usize {
    REMOVE_EXACT_TAG_SCAN_WORK.with(Cell::get)
}

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

fn is_tag_body_start(character: char) -> bool {
    matches!(character, '_' | '-')
        || matches!(
            character.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        )
}

fn is_tag_body_continuation(character: char) -> bool {
    is_tag_body_start(character) || character.general_category_group() == GeneralCategoryGroup::Mark
}

fn is_valid_tag_boundary(previous: Option<char>) -> bool {
    !previous.is_some_and(|character| {
        is_tag_body_continuation(character) || matches!(character, '/' | '#' | '@')
    })
}

pub(crate) fn normalize_tag_identity(source: &str) -> String {
    let nfc = source.nfc().collect::<String>();
    CaseMapper::new().fold_string(&nfc).nfc().collect()
}

pub(crate) fn is_canonical_tag_body(source: &str) -> bool {
    let mut characters = source.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    is_tag_body_start(first)
        && characters.all(is_tag_body_continuation)
        && normalize_tag_identity(source) == source
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
        let invalid_boundary = !is_valid_tag_boundary(
            index
                .checked_sub(1)
                .map(|previous| scalars[previous].character),
        );
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
        let normalized = normalize_tag_identity(&display);
        tags.push(NoteTagToken {
            prefix: prefix.expect("tag prefix"),
            normalized,
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
    #[cfg(test)]
    record_remove_exact_tag_scan_work(source.chars().count());

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

fn exact_tag_candidate_ends(
    source: &str,
    scalars: &[Scalar],
    tag: &NoteTagFilter,
) -> Vec<Option<usize>> {
    let mut candidate_end_by_start = vec![None; scalars.len()];
    let mut index = 0;
    while index < scalars.len() {
        let prefix = match scalars[index].character {
            '#' => Some(NoteTagPrefix::Hash),
            '@' => Some(NoteTagPrefix::Mention),
            _ => None,
        };
        let body_start = index + 1;
        if prefix.is_none()
            || body_start >= scalars.len()
            || !is_tag_body_start(scalars[body_start].character)
        {
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
        let normalized = normalize_tag_identity(&source[body_start_byte..body_end_byte]);
        if prefix == Some(tag.prefix) && normalized == tag.normalized_tag {
            candidate_end_by_start[index] = Some(body_end - 1);
        }
        index = body_end;
    }
    candidate_end_by_start
}

fn contains_url_evidence(source: &str) -> bool {
    let mut offset = 0;
    while offset < source.len() {
        let character = source[offset..].chars().next().expect("source scalar");
        if character.is_whitespace() {
            offset += character.len_utf8();
            continue;
        }
        let segment_start = offset;
        offset += character.len_utf8();
        while offset < source.len() {
            let character = source[offset..].chars().next().expect("segment scalar");
            if character.is_whitespace() {
                break;
            }
            offset += character.len_utf8();
        }
        if find_url_evidence_end(source, segment_start, offset).is_some() {
            return true;
        }
    }
    false
}

/// Fast-forwards isolated adjacent chains even when unrelated URL punctuation
/// appears elsewhere. Canonical tokenization must recognize exactly the first
/// candidate in each chain. Multiple chains are accelerated only when their
/// cleanup ranges consume no spaces and their simultaneous removal leaves no
/// URL evidence, so intermediate round timing cannot change surviving bytes.
///
/// A single chain may consume its preceding ASCII-space runway in one step.
/// While at least one runway space remains, the chain is a tokenizer segment
/// independent from its left context. If the runway ends before the chain, the
/// caller retokenizes the surviving suffix against the newly joined context.
/// With no runway, join-created URL evidence can appear only after the last
/// adjacent target marker is gone.
fn remove_isolated_exact_tag_chains(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let scalars = source
        .char_indices()
        .map(|(byte_start, character)| Scalar {
            character,
            byte_start,
            utf16_start: 0,
        })
        .collect::<Vec<_>>();
    if scalars.is_empty() {
        return None;
    }
    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());

    let candidates = exact_tag_candidate_ends(source, &scalars, tag);
    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());
    let starts = candidates
        .iter()
        .enumerate()
        .filter_map(|(start, end)| end.map(|end| (start, end)))
        .collect::<Vec<_>>();
    if starts.len() < 2 {
        return None;
    }

    let mut chains = Vec::new();
    let mut chain_start = starts[0].0;
    let mut chain_end = starts[0].1;
    let mut chain_count = 1;
    for &(start, end) in &starts[1..] {
        if chain_end + 1 == start {
            chain_end = end;
            chain_count += 1;
        } else {
            chains.push((chain_start, chain_end, chain_count));
            chain_start = start;
            chain_end = end;
            chain_count = 1;
        }
    }
    chains.push((chain_start, chain_end, chain_count));
    if !chains.iter().any(|(_, _, count)| *count >= 2) {
        return None;
    }

    let multiple_chains = chains.len() > 1;
    let mut single_chain_leading_spaces = 0;
    for &(start, end, _) in &chains {
        let leading_spaces = scalars[..start]
            .iter()
            .rev()
            .take_while(|scalar| scalar.character == ' ')
            .count();
        if leading_spaces > 0 {
            if multiple_chains {
                return None;
            }
            single_chain_leading_spaces = leading_spaces;
        }
        if multiple_chains
            && scalars
                .get(end + 1)
                .is_some_and(|scalar| scalar.character == ' ')
        {
            return None;
        }
    }

    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len() * 2);
    let canonical_starts = tokenize_note_text(source)
        .into_iter()
        .filter(|token| token.prefix == tag.prefix && token.normalized == tag.normalized_tag)
        .map(|token| token.start_byte)
        .collect::<Vec<_>>();
    let expected_starts = chains
        .iter()
        .map(|(start, _, _)| scalars[*start].byte_start)
        .collect::<Vec<_>>();
    if canonical_starts != expected_starts {
        return None;
    }

    let mut ranges = Vec::with_capacity(chains.len());
    for &(start, end, count) in &chains {
        let (range_start, range_end, consumes_following_space) =
            if !multiple_chains && single_chain_leading_spaces > 0 {
                let removed_tokens = single_chain_leading_spaces.min(count);
                let removed_end = starts[removed_tokens - 1].1;
                (start - removed_tokens, removed_end, false)
            } else {
                (start, end, !multiple_chains)
            };
        let start_byte = scalars[range_start].byte_start;
        let mut end_byte = scalars
            .get(range_end + 1)
            .map_or(source.len(), |next| next.byte_start);
        if consumes_following_space && source.as_bytes().get(end_byte) == Some(&b' ') {
            end_byte += 1;
        }
        ranges.push((start_byte, end_byte));
    }
    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());
    let removed_bytes = ranges.iter().map(|(start, end)| end - start).sum::<usize>();
    let mut result = String::with_capacity(source.len() - removed_bytes);
    let mut cursor = 0;
    for (start, end) in ranges {
        result.push_str(&source[cursor..start]);
        cursor = end;
    }
    result.push_str(&source[cursor..]);
    if multiple_chains && contains_url_evidence(&result) {
        return None;
    }
    Some(result)
}

fn live_successor(successors: &mut [usize], index: usize) -> usize {
    let mut root = index;
    while successors[root] != root {
        #[cfg(test)]
        record_remove_exact_tag_scan_work(1);
        root = successors[root];
    }

    let mut cursor = index;
    while successors[cursor] != cursor {
        let next = successors[cursor];
        successors[cursor] = root;
        cursor = next;
    }
    root
}

/// Removes exact tokens without rescanning the shrinking string. Callers must
/// prove that URL evidence cannot affect token visibility for the supplied
/// source before accepting this speculative result.
///
/// Each round freezes every cleanup range before mutating the live scalar
/// links. That preserves the existing simultaneous-pass whitespace semantics
/// while an adjacent chain such as `#x#x...` visits each scalar only once.
fn remove_boundary_exact_tag_tokens(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let scalars = source
        .char_indices()
        .map(|(byte_start, character)| Scalar {
            character,
            byte_start,
            utf16_start: 0,
        })
        .collect::<Vec<_>>();
    if scalars.is_empty() {
        return None;
    }

    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());

    // Record every lexical occurrence of the requested identity, including
    // occurrences whose current left boundary is invalid. Deletion cannot
    // shorten a maximal body into a new identity; it can only expose the first
    // marker immediately to the right of a frozen deletion range.
    let candidate_end_by_start = exact_tag_candidate_ends(source, &scalars, tag);
    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());

    let mut previous = (0..scalars.len())
        .map(|scalar_index| scalar_index.checked_sub(1))
        .collect::<Vec<_>>();
    let mut next = (0..scalars.len())
        .map(|scalar_index| (scalar_index + 1 < scalars.len()).then_some(scalar_index + 1))
        .collect::<Vec<_>>();
    let mut alive = vec![true; scalars.len()];
    let mut queued = vec![false; scalars.len()];
    let mut round = candidate_end_by_start
        .iter()
        .enumerate()
        .filter_map(|(start, end)| {
            end.and_then(|_| {
                is_valid_tag_boundary(previous[start].map(|index| scalars[index].character))
                    .then_some(start)
            })
        })
        .collect::<Vec<_>>();
    for start in &round {
        queued[*start] = true;
    }
    if round.is_empty() {
        return None;
    }

    let mut deletion_epoch = vec![0_usize; scalars.len()];
    let mut live_successors = (0..=scalars.len()).collect::<Vec<_>>();
    let mut epoch = 0_usize;
    while !round.is_empty() {
        epoch += 1;
        let mut marked = Vec::new();
        let mut right_probes = Vec::with_capacity(round.len());

        for start in round.drain(..) {
            queued[start] = false;
            if !alive[start] {
                continue;
            }
            let end = candidate_end_by_start[start].expect("queued exact-tag candidate");
            debug_assert!(alive[end]);

            let mut range_start = start;
            let mut range_end = end;
            if previous[start].is_some_and(|index| scalars[index].character == ' ') {
                range_start = previous[start].expect("preceding ASCII space");
            } else if next[end].is_some_and(|index| scalars[index].character == ' ') {
                range_end = next[end].expect("following ASCII space");
            }
            right_probes.push(next[range_end]);

            let mut cursor = range_start;
            loop {
                if deletion_epoch[cursor] != epoch {
                    deletion_epoch[cursor] = epoch;
                    marked.push(cursor);
                }
                if cursor == range_end {
                    break;
                }
                cursor = next[cursor].expect("frozen cleanup range remains live");
            }
        }
        #[cfg(test)]
        record_remove_exact_tag_scan_work(marked.len());

        // Apply the union of all ranges only after every range has been frozen.
        for deleted in marked {
            if !alive[deleted] {
                continue;
            }
            let left = previous[deleted];
            let right = next[deleted];
            if let Some(left) = left {
                next[left] = right;
            }
            if let Some(right) = right {
                previous[right] = left;
            }
            alive[deleted] = false;
            live_successors[deleted] = live_successor(&mut live_successors, deleted + 1);
        }

        for probe in right_probes {
            let Some(probe) = probe else {
                continue;
            };
            let start = live_successor(&mut live_successors, probe);
            if start == scalars.len() {
                continue;
            }
            if candidate_end_by_start[start].is_some()
                && !queued[start]
                && is_valid_tag_boundary(previous[start].map(|index| scalars[index].character))
            {
                queued[start] = true;
                round.push(start);
            }
        }
    }

    #[cfg(test)]
    record_remove_exact_tag_scan_work(scalars.len());
    let result = scalars
        .iter()
        .zip(alive)
        .filter_map(|(scalar, alive)| alive.then_some(scalar.character))
        .collect::<String>();
    Some(result)
}

/// Uses the boundary-only engine when URL evidence is impossible by
/// construction. The outer option distinguishes an intentionally skipped
/// source from a handled source that contains no removable token.
fn remove_url_inert_exact_tag_tokens(source: &str, tag: &NoteTagFilter) -> Option<Option<String>> {
    // Every URL form recognized by `find_url_evidence_end` requires at least
    // one of these scalars. Being deliberately conservative keeps this path
    // independent from URL-detector details and sends ambiguous text through
    // the canonical fallback below.
    if source
        .chars()
        .any(|character| matches!(character, '/' | '.' | ':' | '?'))
    {
        return None;
    }

    Some(remove_boundary_exact_tag_tokens(source, tag))
}

fn push_accelerated_url_free_window(
    output: &mut String,
    window: &str,
    tag: &NoteTagFilter,
) -> bool {
    if contains_url_evidence(window) {
        output.push_str(window);
        return false;
    }

    let Some(candidate) = remove_boundary_exact_tag_tokens(window, tag) else {
        output.push_str(window);
        return false;
    };
    // A deletion that creates URL evidence could hide a token in a later
    // canonical pass. Reject that speculation and preserve the tokenizer as
    // the authority for this window.
    if contains_url_evidence(&candidate) {
        output.push_str(window);
        return false;
    }

    debug_assert!(candidate.len() < window.len());
    output.push_str(&candidate);
    true
}

/// Accelerates only independently mutable windows. Exact-tag cleanup can
/// consume ASCII spaces, but never tabs, newlines, or other whitespace; those
/// hard separators therefore prevent both cleanup ranges and URL evidence from
/// crossing into the neighboring window.
fn remove_url_free_windows(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let mut output = String::with_capacity(source.len());
    let mut window_start = 0;
    let mut changed = false;

    for (offset, character) in source.char_indices() {
        if !character.is_whitespace() || character == ' ' {
            continue;
        }
        changed |=
            push_accelerated_url_free_window(&mut output, &source[window_start..offset], tag);
        let separator_end = offset + character.len_utf8();
        output.push_str(&source[offset..separator_end]);
        window_start = separator_end;
    }
    changed |= push_accelerated_url_free_window(&mut output, &source[window_start..], tag);

    changed.then_some(output)
}

/// Removes every tokenizer-exact occurrence and, for each occurrence, consumes
/// one immediately preceding ASCII space when present or otherwise one
/// immediately following ASCII space. All ranges are UTF-8 byte ranges derived
/// alongside the tokenizer's UTF-16 display offsets.
pub(crate) fn remove_exact_tag_tokens(source: &str, tag: &NoteTagFilter) -> Option<String> {
    let window_accelerated = remove_url_free_windows(source, tag);
    let window_source = window_accelerated.as_deref().unwrap_or(source);
    let chain_accelerated = remove_isolated_exact_tag_chains(window_source, tag);
    let working = chain_accelerated.as_deref().unwrap_or(window_source);

    if let Some(result) = remove_url_inert_exact_tag_tokens(working, tag) {
        return result.or(chain_accelerated).or(window_accelerated);
    }

    let Some(mut result) = remove_exact_tag_tokens_once(working, tag) else {
        return chain_accelerated.or(window_accelerated);
    };
    // A deletion can expose a marker that was not a token in the original
    // source (`#x#x` -> `#x`). Continue to the tokenizer's fixed point so a
    // successful RemoveTag is idempotent while every pass still honors the
    // canonical boundary, URL, prefix, and normalized-identity rules.
    loop {
        if let Some(next) = remove_isolated_exact_tag_chains(&result, tag) {
            debug_assert!(next.len() < result.len());
            result = next;
            continue;
        }
        let Some(next) = remove_exact_tag_tokens_once(&result, tag) else {
            break;
        };
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
        add_exact_tag_to_title, is_canonical_tag_body, is_nfc, normalize_tag_identity,
        remove_exact_tag_scan_work, remove_exact_tag_tokens, remove_exact_tag_tokens_once,
        reset_remove_exact_tag_scan_work, tokenize_note_text,
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

    #[derive(Debug, Deserialize)]
    struct TagIdentityFixture {
        source: String,
        normalized: String,
    }

    #[test]
    fn notes_tag_identity_matches_shared_three_scalar_fold_fixtures() {
        let fixtures: Vec<TagIdentityFixture> = serde_json::from_str(include_str!(
            "../../../src/features/notes/noteTagIdentity.fixtures.json"
        ))
        .expect("shared tag identity fixtures");

        for fixture in fixtures {
            assert_eq!(
                normalize_tag_identity(&fixture.source),
                fixture.normalized,
                "source: {:?}",
                fixture.source
            );
        }
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
    fn notes_tag_identity_uses_default_full_unicode_case_folding() {
        let tokens = tokenize_note_text("#Straße #STRASSE #ﬀ #ff #I #İ #ı #ẛ");
        assert_eq!(
            tokens
                .iter()
                .map(|token| token.normalized.as_str())
                .collect::<Vec<_>>(),
            vec!["strasse", "strasse", "ff", "ff", "i", "i\u{307}", "ı", "ṡ",]
        );
        assert!(tokens.iter().all(|token| is_nfc(&token.normalized)));

        assert!(is_canonical_tag_body("strasse"));
        assert!(!is_canonical_tag_body("straße"));
        assert!(is_canonical_tag_body("ff"));
        assert!(!is_canonical_tag_body("ﬀ"));
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
    fn batch_tag_add_and_remove_share_full_case_folded_identity() {
        assert_eq!(
            add_exact_tag_to_title(
                "Plan #Straße",
                "",
                &search_tag(NoteTagPrefix::Hash, "strasse", "STRASSE"),
            )
            .expect("full-fold equivalent display tag"),
            None
        );
        assert_eq!(
            add_exact_tag_to_title(
                "Plan",
                "support #ﬀ",
                &search_tag(NoteTagPrefix::Hash, "ff", "FF"),
            )
            .expect("full-fold equivalent supporting-note tag"),
            None
        );

        assert_eq!(
            remove_exact_tag_tokens("Plan #Straße and #STRASSE", &hash_tag("strasse")),
            Some("Plan and".to_string())
        );
        assert_eq!(
            remove_exact_tag_tokens("Ligatures #ﬀ and #ff", &hash_tag("ff")),
            Some("Ligatures and".to_string())
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
            ("a  #x#x#x", "a#x"),
            ("#x #x ", " "),
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
    fn batch_tag_remove_adjacent_chain_has_linear_scan_work() {
        let token_count = 2_048;
        for (source, expected) in [
            ("#x".repeat(token_count), String::new()),
            (
                format!("{}{}", " ".repeat(token_count), "#x".repeat(token_count)),
                String::new(),
            ),
            ("#x ".repeat(token_count), " ".to_string()),
            (format!("{}.", "#x".repeat(token_count)), ".".to_string()),
            (
                format!("{}.,#x", "#x".repeat(token_count)),
                ".,".to_string(),
            ),
            (
                format!("{},{}.", "#x".repeat(token_count), "#x".repeat(token_count)),
                ",.".to_string(),
            ),
            (
                format!("{};{}/", "#x".repeat(token_count), "#x".repeat(token_count)),
                ";/".to_string(),
            ),
            (
                format!("{};{}?", "#x".repeat(token_count), "#x".repeat(token_count)),
                ";?".to_string(),
            ),
            (
                format!("{}.a#x", "#x".repeat(token_count)),
                ".a#x".to_string(),
            ),
            (
                format!("{}{}.", " ".repeat(token_count), "#x".repeat(token_count)),
                ".".to_string(),
            ),
            (
                format!(
                    "{}\thttps://example.com/#x\t{}",
                    "#x".repeat(token_count),
                    "#x".repeat(token_count)
                ),
                "\thttps://example.com/#x\t".to_string(),
            ),
            (
                format!(
                    "https://example.com/{}{}",
                    " ".repeat(token_count),
                    "#x".repeat(token_count)
                ),
                "https://example.com/".to_string(),
            ),
            (
                format!(
                    "https://example.com/{}{}",
                    " ".repeat(token_count / 2),
                    "#x".repeat(token_count)
                ),
                format!("https://example.com/{}", "#x".repeat(token_count / 2)),
            ),
            (
                format!(
                    "prefix:{}{}",
                    " ".repeat(token_count / 2),
                    "#x".repeat(token_count)
                ),
                "prefix:".to_string(),
            ),
        ] {
            reset_remove_exact_tag_scan_work();

            assert_eq!(
                remove_exact_tag_tokens(&source, &hash_tag("x")),
                Some(expected)
            );

            let scan_work = remove_exact_tag_scan_work();
            let scalar_count = source.chars().count();
            assert!(
                scan_work <= scalar_count * 16,
                "adjacent-chain removal used {scan_work} work units for {scalar_count} scalars"
            );
        }
    }

    #[test]
    fn batch_tag_remove_preserves_snapshot_semantics_when_deletion_creates_url_evidence() {
        let tag = hash_tag("x");

        assert_eq!(
            remove_exact_tag_tokens("http: #x//:#x", &tag),
            Some("http://:".to_string())
        );
        assert_eq!(
            remove_exact_tag_tokens("http://  #x#x,#x#x#x", &tag),
            Some("http://,#x".to_string())
        );
        assert_eq!(
            remove_exact_tag_tokens("#x.com:#x", &tag),
            Some(".com:".to_string())
        );
    }

    #[test]
    fn batch_tag_remove_fast_path_preserves_unicode_and_prefix_identity() {
        assert_eq!(
            remove_exact_tag_tokens("#CAFE\u{301}#café", &hash_tag("café")),
            Some(String::new())
        );
        assert_eq!(
            remove_exact_tag_tokens("#x@x @X", &hash_tag("x")),
            Some("@x @X".to_string())
        );
    }

    #[test]
    fn batch_tag_remove_fast_path_matches_the_canonical_fixed_point() {
        fn canonical_remove(source: &str, tag: &NoteTagFilter) -> Option<String> {
            let mut result = remove_exact_tag_tokens_once(source, tag)?;
            while let Some(next) = remove_exact_tag_tokens_once(&result, tag) {
                result = next;
            }
            Some(result)
        }

        let alphabet = [
            'a', ' ', '#', '@', 'x', 'X', ',', '\t', '\n', 'é', '.', '/', ':', '?',
        ];
        let tag = hash_tag("x");
        let mut seed = 0x5eed_u64;
        for case in 0..10_000 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let length = (seed as usize % 13) + 1;
            let mut source = String::with_capacity(length);
            for _ in 0..length {
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                source.push(alphabet[seed as usize % alphabet.len()]);
            }

            assert_eq!(
                remove_exact_tag_tokens(&source, &tag),
                canonical_remove(&source, &tag),
                "case {case}, source: {source:?}"
            );
        }

        for prefix in [
            "",
            ",",
            "http:",
            "www.",
            "./",
            "example.com:",
            "a ",
            "\t",
            "(",
        ] {
            for suffix in ["", ".", "/", "//:#x", " .", "@x", "#y", ",#x"] {
                let source = format!("{prefix}#x#X#x{suffix}");
                assert_eq!(
                    remove_exact_tag_tokens(&source, &tag),
                    canonical_remove(&source, &tag),
                    "isolated chain source: {source:?}"
                );
            }
        }
        for source in [
            "#x#x,#x#x.",
            "#x,#x#x#x.",
            "#x#x,#x#x/",
            "www #x.,#x#x",
            "http:#x//#x#x",
            "http:#x#x//:#x#x#x",
        ] {
            assert_eq!(
                remove_exact_tag_tokens(source, &tag),
                canonical_remove(source, &tag),
                "multiple chain source: {source:?}"
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
