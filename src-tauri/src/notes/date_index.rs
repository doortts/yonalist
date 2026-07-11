use crate::notes::tags::tokenize_note_text;
use rusqlite::Connection;
use serde::Deserialize;
use unicode_general_category::{get_general_category, GeneralCategory};

const MIN_YEAR: i32 = 1;
const MAX_YEAR: i32 = 9999;
const NATURAL_PHRASES: [&str; 12] = [
    "yesterday",
    "tomorrow",
    "this month",
    "next month",
    "last month",
    "this week",
    "next week",
    "last week",
    "this year",
    "next year",
    "last year",
    "today",
];

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WeekStartsOn {
    Monday,
    Sunday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct LocalDate {
    pub(crate) year: i32,
    pub(crate) month: u8,
    pub(crate) day: u8,
}

impl LocalDate {
    pub(crate) fn new(year: i32, month: u8, day: u8) -> Option<Self> {
        let date = Self { year, month, day };
        date.is_valid().then_some(date)
    }

    pub(crate) fn parse_iso(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year = parse_ascii_number(&bytes[0..4])? as i32;
        let month = parse_ascii_number(&bytes[5..7])? as u8;
        let day = parse_ascii_number(&bytes[8..10])? as u8;
        Self::new(year, month, day)
    }

    pub(crate) fn to_iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    fn is_valid(self) -> bool {
        (MIN_YEAR..=MAX_YEAR).contains(&self.year)
            && (1..=12).contains(&self.month)
            && self.day >= 1
            && self.day <= days_in_month(self.year, self.month)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoteDateMatch {
    pub(crate) raw: String,
    pub(crate) start_utf16: usize,
    pub(crate) end_utf16: usize,
    pub(crate) start: LocalDate,
    pub(crate) end: Option<LocalDate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NoteDateRange {
    pub(crate) start: LocalDate,
    pub(crate) end: LocalDate,
}

pub(crate) trait LocalTodayProvider {
    fn local_today(&self, connection: &Connection) -> Result<LocalDate, String>;
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct SystemLocalTodayProvider;

impl LocalTodayProvider for SystemLocalTodayProvider {
    fn local_today(&self, connection: &Connection) -> Result<LocalDate, String> {
        let value = connection
            .query_row("SELECT date('now', 'localtime')", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("Could not resolve the system local date: {error}"))?;
        LocalDate::parse_iso(&value)
            .ok_or_else(|| "The system local date was not a valid calendar date.".to_string())
    }
}

#[derive(Debug, Clone, Copy)]
struct Scalar {
    character: char,
    byte_start: usize,
    utf16_start: usize,
}

#[derive(Debug, Clone, Copy)]
struct NumericCandidate {
    month: u8,
    day: u8,
    explicit_year: Option<i32>,
    end_byte: usize,
}

#[derive(Debug, Clone, Copy)]
struct InternalMatch {
    start: LocalDate,
    end: Option<LocalDate>,
    end_byte: usize,
}

#[derive(Debug, Clone, Copy)]
enum Attempt {
    Match(InternalMatch),
    Rejected { end_byte: usize },
}

fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(date: LocalDate) -> i64 {
    let mut year = i64::from(date.year);
    if date.month <= 2 {
        year -= 1;
    }
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = i64::from(date.month) + if date.month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + i64::from(date.day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era
}

fn civil_from_days(serial_day: i64) -> Option<LocalDate> {
    let era = serial_day.div_euclid(146_097);
    let day_of_era = serial_day - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let adjusted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * adjusted_month + 2) / 5 + 1;
    let month = adjusted_month + if adjusted_month < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    LocalDate::new(
        year.try_into().ok()?,
        month.try_into().ok()?,
        day.try_into().ok()?,
    )
}

fn add_days(date: LocalDate, amount: i64) -> Option<LocalDate> {
    civil_from_days(days_from_civil(date).checked_add(amount)?)
}

fn add_months(date: LocalDate, amount: i32) -> Option<LocalDate> {
    let absolute_month = (date.year - 1)
        .checked_mul(12)?
        .checked_add(i32::from(date.month) - 1)?
        .checked_add(amount)?;
    if !(0..MAX_YEAR * 12).contains(&absolute_month) {
        return None;
    }
    let year = absolute_month / 12 + 1;
    let month = (absolute_month % 12 + 1) as u8;
    LocalDate::new(year, month, date.day.min(days_in_month(year, month)))
}

fn start_of_week(date: LocalDate, week_starts_on: WeekStartsOn) -> Option<LocalDate> {
    let epoch = LocalDate::new(1970, 1, 1).expect("Unix epoch is valid");
    let weekday = (days_from_civil(date) - days_from_civil(epoch) + 4).rem_euclid(7);
    let first_day = match week_starts_on {
        WeekStartsOn::Monday => 1,
        WeekStartsOn::Sunday => 0,
    };
    add_days(date, -(weekday - first_day).rem_euclid(7))
}

fn is_mark(character: char) -> bool {
    matches!(
        get_general_category(character),
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

fn is_word_character(character: char) -> bool {
    character == '_' || character.is_alphanumeric() || is_mark(character)
}

fn has_start_boundary(scalars: &[Scalar], index: usize) -> bool {
    index == 0
        || (!is_word_character(scalars[index - 1].character) && scalars[index - 1].character != '/')
}

fn has_numeric_start_boundary(scalars: &[Scalar], index: usize) -> bool {
    has_start_boundary(scalars, index) && (index == 0 || scalars[index - 1].character != '-')
}

fn next_character(source: &str, byte_offset: usize) -> Option<char> {
    source.get(byte_offset..)?.chars().next()
}

fn has_natural_end_boundary(source: &str, end_byte: usize) -> bool {
    next_character(source, end_byte).map_or(true, |character| !is_word_character(character))
}

fn has_numeric_end_boundary(source: &str, end_byte: usize) -> bool {
    next_character(source, end_byte).map_or(true, |character| {
        !is_word_character(character) && character != '/' && character != '-'
    })
}

fn parse_ascii_number(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0_u32, |value, byte| {
        value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))
    })
}

fn read_yearless_candidate(source: &str, start_byte: usize) -> Option<NumericCandidate> {
    let bytes = source.as_bytes();
    let end_byte = start_byte.checked_add(5)?;
    if end_byte > bytes.len() {
        return None;
    }
    let separator = bytes[start_byte + 2];
    if !matches!(separator, b'-' | b'/') {
        return None;
    }
    Some(NumericCandidate {
        month: parse_ascii_number(&bytes[start_byte..start_byte + 2])?
            .try_into()
            .ok()?,
        day: parse_ascii_number(&bytes[start_byte + 3..end_byte])?
            .try_into()
            .ok()?,
        explicit_year: None,
        end_byte,
    })
}

fn read_numeric_candidate(source: &str, start_byte: usize) -> Option<NumericCandidate> {
    let mut candidate = read_yearless_candidate(source, start_byte)?;
    let bytes = source.as_bytes();
    let separator = bytes[start_byte + 2];
    if bytes.get(candidate.end_byte).copied() != Some(separator) {
        return Some(candidate);
    }
    let year_start = candidate.end_byte + 1;
    let mut year_end = year_start;
    while bytes.get(year_end).is_some_and(u8::is_ascii_digit) {
        year_end += 1;
    }
    let year_length = year_end - year_start;
    if year_length != 2 && year_length != 4 {
        return None;
    }
    let parsed_year = parse_ascii_number(&bytes[year_start..year_end])? as i32;
    candidate.explicit_year = Some(if year_length == 2 {
        2000 + parsed_year
    } else {
        parsed_year
    });
    candidate.end_byte = year_end;
    Some(candidate)
}

fn resolve_candidate(candidate: NumericCandidate, year: i32) -> Option<LocalDate> {
    LocalDate::new(year, candidate.month, candidate.day)
}

fn resolve_numeric_range(
    start_candidate: NumericCandidate,
    end_candidate: NumericCandidate,
    today_year: i32,
) -> Option<(LocalDate, LocalDate)> {
    let mut start_year = start_candidate.explicit_year;
    let mut end_year = end_candidate.explicit_year;
    let may_cross_year = start_candidate.month == 12 && end_candidate.month == 1;

    match (start_year, end_year) {
        (None, None) => {
            start_year = Some(today_year);
            end_year = Some(today_year);
            let start = resolve_candidate(start_candidate, today_year)?;
            let end = resolve_candidate(end_candidate, today_year)?;
            if end < start && may_cross_year {
                end_year = today_year.checked_add(1);
            }
        }
        (Some(year), None) => {
            end_year = Some(year);
            let start = resolve_candidate(start_candidate, year)?;
            let end = resolve_candidate(end_candidate, year)?;
            if end < start && may_cross_year {
                end_year = year.checked_add(1);
            }
        }
        (None, Some(year)) => {
            start_year = Some(year);
            let start = resolve_candidate(start_candidate, year)?;
            let end = resolve_candidate(end_candidate, year)?;
            if start > end && may_cross_year {
                start_year = year.checked_sub(1);
            }
        }
        (Some(_), Some(_)) => {}
    }

    let start = resolve_candidate(start_candidate, start_year?)?;
    let end = resolve_candidate(end_candidate, end_year?)?;
    (start <= end).then_some((start, end))
}

fn malformed_range_end(source: &str, start_byte: usize) -> usize {
    let mut end_byte = start_byte;
    for (relative_byte, character) in source[start_byte..].char_indices() {
        if character.is_whitespace() {
            break;
        }
        end_byte = start_byte + relative_byte + character.len_utf8();
    }
    end_byte
}

fn try_numeric_range(
    source: &str,
    start_candidate: NumericCandidate,
    today_year: i32,
) -> Option<Attempt> {
    let bytes = source.as_bytes();
    let mut separator = start_candidate.end_byte;
    while bytes
        .get(separator)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        separator += 1;
    }
    if bytes.get(separator) != Some(&b'-') {
        return None;
    }
    let has_before_space = separator > start_candidate.end_byte;
    let mut end_start = separator + 1;
    while bytes
        .get(end_start)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        end_start += 1;
    }
    let has_after_space = end_start > separator + 1;
    let malformed_end = malformed_range_end(source, end_start);
    if let Some(end_candidate) = read_numeric_candidate(source, end_start) {
        if has_numeric_end_boundary(source, end_candidate.end_byte) {
            if has_before_space && has_after_space {
                if let Some((start, end)) =
                    resolve_numeric_range(start_candidate, end_candidate, today_year)
                {
                    return Some(Attempt::Match(InternalMatch {
                        start,
                        end: Some(end),
                        end_byte: end_candidate.end_byte,
                    }));
                }
            }
            return Some(Attempt::Rejected {
                end_byte: end_candidate.end_byte,
            });
        }
    }
    (has_before_space || has_after_space).then_some(Attempt::Rejected {
        end_byte: malformed_end,
    })
}

fn try_numeric_match(
    source: &str,
    scalars: &[Scalar],
    index: usize,
    today_year: i32,
) -> Option<Attempt> {
    if !has_numeric_start_boundary(scalars, index) {
        return None;
    }
    let start_byte = scalars[index].byte_start;
    let yearless = read_yearless_candidate(source, start_byte)?;
    if let Some(attempt) = try_numeric_range(source, yearless, today_year) {
        return Some(attempt);
    }
    let candidate = read_numeric_candidate(source, start_byte)?;
    if candidate.end_byte != yearless.end_byte {
        if let Some(attempt) = try_numeric_range(source, candidate, today_year) {
            return Some(attempt);
        }
    }
    if !has_numeric_end_boundary(source, candidate.end_byte) {
        return None;
    }
    Some(Attempt::Match(InternalMatch {
        start: resolve_candidate(candidate, candidate.explicit_year.unwrap_or(today_year))?,
        end: None,
        end_byte: candidate.end_byte,
    }))
}

fn resolve_natural_phrase(
    phrase: &str,
    today: LocalDate,
    week_starts_on: WeekStartsOn,
) -> Option<(LocalDate, Option<LocalDate>)> {
    match phrase {
        "today" => Some((today, None)),
        "tomorrow" => Some((add_days(today, 1)?, None)),
        "yesterday" => Some((add_days(today, -1)?, None)),
        _ => {
            let (relative, period) = phrase.split_once(' ')?;
            let offset = match relative {
                "this" => 0,
                "next" => 1,
                "last" => -1,
                _ => return None,
            };
            match period {
                "week" => {
                    let start = add_days(start_of_week(today, week_starts_on)?, offset * 7)?;
                    Some((start, Some(add_days(start, 6)?)))
                }
                "month" => {
                    let first = LocalDate::new(today.year, today.month, 1)?;
                    let start = add_months(first, offset.try_into().ok()?)?;
                    let end = LocalDate::new(
                        start.year,
                        start.month,
                        days_in_month(start.year, start.month),
                    )?;
                    Some((start, Some(end)))
                }
                "year" => {
                    let year = today.year.checked_add(offset.try_into().ok()?)?;
                    Some((
                        LocalDate::new(year, 1, 1)?,
                        Some(LocalDate::new(year, 12, 31)?),
                    ))
                }
                _ => None,
            }
        }
    }
}

fn try_natural_match(
    source: &str,
    scalars: &[Scalar],
    index: usize,
    today: LocalDate,
    week_starts_on: WeekStartsOn,
) -> Option<InternalMatch> {
    if !has_start_boundary(scalars, index) {
        return None;
    }
    let start_byte = scalars[index].byte_start;
    for phrase in NATURAL_PHRASES {
        let Some(end_byte) = start_byte.checked_add(phrase.len()) else {
            continue;
        };
        let Some(candidate) = source.get(start_byte..end_byte) else {
            continue;
        };
        if candidate.eq_ignore_ascii_case(phrase) && has_natural_end_boundary(source, end_byte) {
            let (start, end) = resolve_natural_phrase(phrase, today, week_starts_on)?;
            return Some(InternalMatch {
                start,
                end,
                end_byte,
            });
        }
    }
    None
}

pub(crate) fn find_note_date_matches(
    source: &str,
    today: LocalDate,
    week_starts_on: WeekStartsOn,
) -> Vec<NoteDateMatch> {
    if !today.is_valid() {
        return Vec::new();
    }
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
    let excluded_tag_spans = tokenize_note_text(source)
        .into_iter()
        .map(|tag| (tag.start_utf16, tag.end_utf16))
        .collect::<Vec<_>>();
    let mut tag_index = 0;
    let mut matches = Vec::new();
    let mut index = 0;

    while index < scalars.len() {
        let scalar = scalars[index];
        while excluded_tag_spans
            .get(tag_index)
            .is_some_and(|(_, end)| *end <= scalar.utf16_start)
        {
            tag_index += 1;
        }
        if excluded_tag_spans
            .get(tag_index)
            .is_some_and(|(start, end)| *start <= scalar.utf16_start && scalar.utf16_start < *end)
        {
            index += 1;
            continue;
        }

        let attempt = if scalar.character.is_ascii_digit() {
            try_numeric_match(source, &scalars, index, today.year)
        } else {
            try_natural_match(source, &scalars, index, today, week_starts_on).map(Attempt::Match)
        };
        let Some(attempt) = attempt else {
            index += 1;
            continue;
        };
        let (matched, end_byte) = match attempt {
            Attempt::Match(matched) => (Some(matched), matched.end_byte),
            Attempt::Rejected { end_byte } => (None, end_byte),
        };
        while index < scalars.len() && scalars[index].byte_start < end_byte {
            index += 1;
        }
        if let Some(matched) = matched {
            let end_utf16 = scalars
                .get(index)
                .map_or(utf16_start, |scalar| scalar.utf16_start);
            matches.push(NoteDateMatch {
                raw: source[scalar.byte_start..end_byte].to_string(),
                start_utf16: scalar.utf16_start,
                end_utf16,
                start: matched.start,
                end: matched.end,
            });
        }
    }
    matches
}

pub(crate) fn parse_note_date_expression(
    input: &str,
    today: LocalDate,
    week_starts_on: WeekStartsOn,
) -> Option<NoteDateRange> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let start_byte = input.find(trimmed)?;
    let start_utf16 = input[..start_byte].encode_utf16().count();
    let end_utf16 = start_utf16 + trimmed.encode_utf16().count();
    let matches = find_note_date_matches(input, today, week_starts_on);
    if matches.len() != 1
        || matches[0].start_utf16 != start_utf16
        || matches[0].end_utf16 != end_utf16
    {
        return None;
    }
    Some(NoteDateRange {
        start: matches[0].start,
        end: matches[0].end.unwrap_or(matches[0].start),
    })
}

#[cfg(test)]
mod tests {
    use super::{find_note_date_matches, LocalDate, NoteDateMatch, WeekStartsOn};
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        source: String,
        today: String,
        week_starts_on: WeekStartsOn,
        matches: Vec<ExpectedMatch>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedMatch {
        raw: String,
        start_utf16: usize,
        end_utf16: usize,
        normalized_start: String,
        normalized_end: String,
    }

    impl From<NoteDateMatch> for ExpectedMatch {
        fn from(value: NoteDateMatch) -> Self {
            Self {
                raw: value.raw,
                start_utf16: value.start_utf16,
                end_utf16: value.end_utf16,
                normalized_start: value.start.to_iso(),
                normalized_end: value.end.unwrap_or(value.start).to_iso(),
            }
        }
    }

    #[test]
    fn notes_date_parser_matches_shared_typescript_fixtures() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../../src/features/notes/noteDateFixtures.json"
        ))
        .expect("shared date fixtures");

        for fixture in fixtures {
            let today = LocalDate::parse_iso(&fixture.today).expect("fixture today");
            let actual = find_note_date_matches(&fixture.source, today, fixture.week_starts_on)
                .into_iter()
                .map(ExpectedMatch::from)
                .collect::<Vec<_>>();
            assert_eq!(actual, fixture.matches, "fixture: {}", fixture.name);
        }
    }
}
