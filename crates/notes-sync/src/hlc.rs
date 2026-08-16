use std::io;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, Error};

const MILLIS_WIDTH: usize = 9;
const COUNTER_WIDTH: usize = 2;
const DEVICE_WIDTH: usize = 4;
/// `36^9 - 1` and `36^2 - 1`: the largest values the fixed-width fields hold.
const MAX_MILLIS: u64 = 101_559_956_668_415;
const MAX_COUNTER: u32 = 1_295;
const ENCODED_WIDTH: usize = MILLIS_WIDTH + COUNTER_WIDTH + DEVICE_WIDTH + 2;

/// A hybrid logical clock reading: wall-clock milliseconds, a counter that
/// orders readings inside one millisecond, and the device that issued it.
///
/// Encoded it is 17 characters of fixed width, which is the whole point:
/// comparing the strings compares the times, so Rust, SQL and anything reading
/// the vault agree on the order without parsing anything.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Hlc {
    millis: u64,
    counter: u32,
    device: String,
}

impl Hlc {
    pub fn new(millis: u64, counter: u32, device: &str) -> Result<Self, String> {
        if millis > MAX_MILLIS {
            return Err("HLC milliseconds exceed the fixed-width encoding.".into());
        }
        if counter > MAX_COUNTER {
            return Err("HLC counter exceeds the fixed-width encoding.".into());
        }
        if device.len() != DEVICE_WIDTH || !device.bytes().all(is_lowercase_hex) {
            return Err("HLC device must be four lowercase hexadecimal characters.".into());
        }
        Ok(Self {
            millis,
            counter,
            device: device.to_owned(),
        })
    }

    /// Which device issued this reading. The merge uses it to tell an edit made
    /// in this vault from one that arrived from elsewhere — no other evidence
    /// of that survives the trip through a file.
    pub fn device(&self) -> &str {
        &self.device
    }

    pub fn encode(&self) -> String {
        format!(
            "{}-{}-{}",
            encode_base36(self.millis, MILLIS_WIDTH),
            encode_base36(u64::from(self.counter), COUNTER_WIDTH),
            self.device
        )
    }

    /// Round-trips through `encode` before accepting: a value that spells the
    /// same reading a second way is not this encoding, and letting it through
    /// would break the "string order is time order" contract.
    pub fn decode(value: &str) -> Result<Self, String> {
        if value.len() != ENCODED_WIDTH {
            return Err("HLC must be 17 characters.".into());
        }
        let bytes = value.as_bytes();
        if bytes[MILLIS_WIDTH] != b'-' || bytes[MILLIS_WIDTH + COUNTER_WIDTH + 1] != b'-' {
            return Err("HLC separators are invalid.".into());
        }
        let millis = decode_base36(&value[..MILLIS_WIDTH])?;
        let counter = decode_base36(&value[MILLIS_WIDTH + 1..MILLIS_WIDTH + COUNTER_WIDTH + 1])?;
        let counter =
            u32::try_from(counter).map_err(|_| "HLC counter exceeds the supported range.")?;
        let hlc = Self::new(millis, counter, &value[MILLIS_WIDTH + COUNTER_WIDTH + 2..])?;
        if hlc.encode() != value {
            return Err("HLC is not canonically encoded.".into());
        }
        Ok(hlc)
    }
}

fn is_lowercase_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn encode_base36(mut value: u64, width: usize) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = vec![b'0'; width];
    for slot in digits.iter_mut().rev() {
        *slot = ALPHABET[(value % 36) as usize];
        value /= 36;
    }
    String::from_utf8(digits).expect("base36 digits are ascii")
}

fn decode_base36(value: &str) -> Result<u64, String> {
    let mut result: u64 = 0;
    for byte in value.bytes() {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte - b'0'),
            b'a'..=b'z' => u64::from(byte - b'a') + 10,
            _ => return Err("HLC contains a character outside base36.".into()),
        };
        result = result
            .checked_mul(36)
            .and_then(|scaled| scaled.checked_add(digit))
            .ok_or("HLC exceeds the supported range.")?;
    }
    Ok(result)
}

#[derive(Default)]
struct ClockState {
    millis: u64,
    counter: u32,
}

/// The device's clock. One per open database, owned by whoever opened it —
/// there is no process-wide clock, so two databases in one process (tests, or a
/// second vault) never share a reading.
pub struct Clock {
    device: String,
    state: Mutex<ClockState>,
}

impl Clock {
    pub fn new(device: &str) -> Result<Self, String> {
        // Validated by building a reading with it, so the device rule lives in
        // one place.
        Hlc::new(0, 0, device)?;
        Ok(Self {
            device: device.to_owned(),
            state: Mutex::new(ClockState::default()),
        })
    }

    pub fn now(&self) -> Result<Hlc, String> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let millis =
            u64::try_from(millis).map_err(|_| "System time exceeds the HLC millisecond range.")?;
        self.now_at(millis)
    }

    /// A reading never goes backwards. The system clock can, so the logical
    /// millisecond only ever rises; and when the counter fills inside one
    /// millisecond — a bulk paste stamping thousands of rows does reach this —
    /// it carries into the millisecond rather than repeating a reading.
    fn now_at(&self, system_millis: u64) -> Result<Hlc, String> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if system_millis > state.millis {
            state.millis = system_millis;
            state.counter = 0;
        } else if state.counter == MAX_COUNTER {
            state.millis = state
                .millis
                .checked_add(1)
                .ok_or("HLC milliseconds overflowed.")?;
            state.counter = 0;
        } else {
            state.counter += 1;
        }
        Hlc::new(state.millis, state.counter, &self.device)
    }

    /// Pulls the clock up to a reading seen elsewhere, so everything issued
    /// after a merge beats what the merge brought in.
    ///
    /// Callers must not hand this a reading from far in the future. A device
    /// with a broken clock can stamp one near the encoding ceiling, and taking
    /// it would leave `now` unable to issue anything at all — including the
    /// delete that would remove the row it came from. Spec §9 puts that guard
    /// on the merge; `reseed` applies it to what the database already holds.
    pub fn observe(&self, remote: &Hlc) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if (remote.millis, remote.counter) > (state.millis, state.counter) {
            state.millis = remote.millis;
            state.counter = remote.counter;
        }
    }

    /// How far ahead of the wall clock a reading may be before it counts as a
    /// broken device rather than a fast one (spec §9).
    pub fn is_beyond_drift(&self, remote: &Hlc) -> bool {
        const MAX_DRIFT_MILLIS: u64 = 24 * 60 * 60 * 1_000;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let now = u64::try_from(now).unwrap_or(u64::MAX);
        remote.millis > now.saturating_add(MAX_DRIFT_MILLIS)
    }
}

/// Rebuilds the clock from what the database already holds. The clock is
/// derived state, not stored: persisting it invites a crash to leave a saved
/// reading behind the rows it already stamped, and a clock that went backwards
/// silently loses the next edit.
pub fn reseed(clock: &Clock, connection: &Connection) -> Result<(), String> {
    // Both halves of the spec's source: a row that was merged and then deleted
    // locally leaves nothing behind in `notes_nodes`, so the largest reading
    // this device applied has to come from the documents table as well.
    let stored: Option<String> = connection
        .query_row(
            "SELECT MAX(value) FROM (
                 SELECT MAX(hlc) AS value FROM notes_nodes
                 UNION ALL
                 SELECT MAX(applied_max_hlc) FROM sync_documents
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read the stored Notes HLCs: {error}"))?;
    if let Some(value) = stored.filter(|value| !value.is_empty()) {
        let stored = Hlc::decode(&value)?;
        // A reading from a device whose clock ran away would pin this one to the
        // same place forever, so it is left behind rather than adopted. The row
        // keeps its value; the merge re-stamps it when it next comes past.
        if !clock.is_beyond_drift(&stored) {
            clock.observe(&stored);
        }
    }
    Ok(())
}

/// Publishes the clock to SQL as `yona_hlc()`, which is how the stamping
/// triggers reach it without any mutation code being rewritten.
pub fn register(connection: &Connection, clock: Arc<Clock>) -> Result<(), String> {
    connection
        .create_scalar_function("yona_hlc", 0, FunctionFlags::SQLITE_UTF8, move |_| {
            clock.now().map(|hlc| hlc.encode()).map_err(|message| {
                Error::UserFunctionError(Box::new(io::Error::new(
                    io::ErrorKind::InvalidData,
                    message,
                )))
            })
        })
        .map_err(|error| format!("Could not configure the Notes HLC SQL function: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use proptest::prelude::*;

    fn clock() -> Clock {
        Clock::new("a3f2").expect("clock")
    }

    #[test]
    fn a_reading_from_the_far_future_is_left_behind() {
        let clock = clock();
        let runaway = Hlc::new(MAX_MILLIS, MAX_COUNTER, "b1c2").expect("runaway");

        assert!(clock.is_beyond_drift(&runaway));
        // Taking it carries past the encoding ceiling and leaves `now` erroring
        // for every caller after it — the wedge the guard exists to keep out.
        clock.observe(&runaway);
        assert!(clock.now_at(1).is_err());
    }

    #[test]
    fn a_non_ascii_reading_is_refused_without_panicking() {
        assert!(Hlc::decode("00000000é-0-a3f2").is_err());
    }

    #[test]
    fn encode_decode_round_trips_canonically() {
        let hlc = Hlc::new(1_234_567, 42, "a3f2").expect("hlc");
        assert_eq!(Hlc::decode(&hlc.encode()).expect("decode"), hlc);

        for malformed in [
            "",
            "0swkd7qz5-00-a3f2x",
            "0swkd7qz5:00:a3f2",
            "0SWKD7QZ5-00-a3f2",
            "0swkd7qz5-00-A3F2",
            "0swkd7qz5-00-zzzz",
        ] {
            assert!(
                Hlc::decode(malformed).is_err(),
                "a value that is not this encoding must not decode: {malformed}"
            );
        }
    }

    #[test]
    fn now_is_monotonic_across_clock_regression() {
        let clock = clock();
        let ahead = clock.now_at(1_000).expect("ahead");
        let behind = clock.now_at(10).expect("behind");

        assert!(
            behind.encode() > ahead.encode(),
            "a reading never goes backwards even when the system clock does"
        );
    }

    #[test]
    fn observe_makes_the_next_now_beat_the_remote() {
        let clock = clock();
        let remote = Hlc::new(9_999, 7, "b1c2").expect("remote");

        clock.observe(&remote);

        assert!(clock.now_at(1).expect("now").encode() > remote.encode());
    }

    #[test]
    fn counter_overflow_carries_into_millis() {
        let clock = clock();
        let mut last = clock.now_at(500).expect("first");

        // One millisecond holds 1,296 readings; a bulk paste stamping thousands
        // of rows in one transaction reaches the carry.
        for _ in 0..2_000 {
            let next = clock.now_at(500).expect("next");
            assert!(next.encode() > last.encode(), "readings never repeat");
            last = next;
        }
        assert!(
            last.millis > 500,
            "the counter carried into the millisecond"
        );
    }

    proptest! {
        /// Every merge property downstream rests on this one: the whole point of
        /// the fixed-width encoding is that comparing two strings is comparing
        /// two times, device included. Two readings from different devices in
        /// the same millisecond still have to order the same way on both of
        /// them, or a merge would reach different answers depending on where it
        /// ran.
        #[test]
        fn prop_hlc_string_order_equals_component_order(
            left_millis in 0u64..=MAX_MILLIS,
            left_counter in 0u32..=MAX_COUNTER,
            left_device in "[0-9a-f]{4}",
            right_millis in 0u64..=MAX_MILLIS,
            right_counter in 0u32..=MAX_COUNTER,
            right_device in "[0-9a-f]{4}",
        ) {
            let left = Hlc::new(left_millis, left_counter, &left_device).expect("left");
            let right = Hlc::new(right_millis, right_counter, &right_device).expect("right");

            prop_assert_eq!(left.encode().len(), 17);
            prop_assert_eq!(
                left.encode() < right.encode(),
                (left_millis, left_counter, left_device.as_str())
                    < (right_millis, right_counter, right_device.as_str())
            );
        }

        /// Decoding is exact, so a reading survives the trip through a file and
        /// comes back the same reading rather than a nearby one.
        #[test]
        fn prop_an_encoded_hlc_decodes_to_itself(
            millis in 0u64..=MAX_MILLIS,
            counter in 0u32..=MAX_COUNTER,
            device in "[0-9a-f]{4}",
        ) {
            let hlc = Hlc::new(millis, counter, &device).expect("hlc");

            prop_assert_eq!(Hlc::decode(&hlc.encode()).expect("decode"), hlc);
        }
    }

    #[test]
    fn encoding_orders_lexicographically_like_time() {
        let earlier = Hlc::new(1, 0, "a3f2").expect("hlc");
        let later = Hlc::new(1, 1, "a3f2").expect("hlc");
        let much_later = Hlc::new(2, 0, "a3f2").expect("hlc");

        assert!(earlier.encode() < later.encode());
        assert!(later.encode() < much_later.encode());
        assert_eq!(earlier.encode().len(), 17);
    }
}
