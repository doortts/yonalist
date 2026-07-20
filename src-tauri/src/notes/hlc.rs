use rusqlite::{functions::FunctionFlags, Connection, Error};
use std::io;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

const MILLIS_WIDTH: usize = 9;
const COUNTER_WIDTH: usize = 2;
const DEVICE_WIDTH: usize = 4;
const MAX_MILLIS: u64 = 101_559_956_668_415; // 36^9 - 1
const MAX_COUNTER: u32 = 1_295; // 36^2 - 1

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hlc {
    pub(crate) millis: u64,
    pub(crate) counter: u32,
    pub(crate) device: String,
}

impl Hlc {
    pub(crate) fn encode(&self) -> Result<String, String> {
        if self.millis > MAX_MILLIS {
            return Err("HLC milliseconds exceed the fixed-width encoding.".to_string());
        }
        if self.counter > MAX_COUNTER {
            return Err("HLC counter exceeds the fixed-width encoding.".to_string());
        }
        if self.device.len() != DEVICE_WIDTH
            || !self
                .device
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("HLC device must be four lowercase hexadecimal characters.".to_string());
        }
        Ok(format!(
            "{}-{}-{}",
            encode_base36(self.millis, MILLIS_WIDTH),
            encode_base36(u64::from(self.counter), COUNTER_WIDTH),
            self.device
        ))
    }

    pub(crate) fn decode(value: &str) -> Result<Self, String> {
        if value.len() != MILLIS_WIDTH + COUNTER_WIDTH + DEVICE_WIDTH + 2 {
            return Err("HLC must be 17 characters.".to_string());
        }
        let bytes = value.as_bytes();
        if bytes[MILLIS_WIDTH] != b'-' || bytes[MILLIS_WIDTH + COUNTER_WIDTH + 1] != b'-' {
            return Err("HLC separators are invalid.".to_string());
        }
        let millis = decode_base36(&value[..MILLIS_WIDTH])?;
        let counter = decode_base36(&value[MILLIS_WIDTH + 1..MILLIS_WIDTH + COUNTER_WIDTH + 1])?;
        let counter = u32::try_from(counter)
            .map_err(|_| "HLC counter exceeds the supported range.".to_string())?;
        let hlc = Self {
            millis,
            counter,
            device: value[MILLIS_WIDTH + COUNTER_WIDTH + 2..].to_string(),
        };
        if hlc.encode()? != value {
            return Err("HLC is not canonically encoded.".to_string());
        }
        Ok(hlc)
    }
}

#[derive(Default)]
struct HlcClock {
    millis: u64,
    counter: u32,
}

impl HlcClock {
    fn now_at(&mut self, system_millis: u64, device: &str) -> Result<String, String> {
        if system_millis > self.millis {
            self.millis = system_millis;
            self.counter = 0;
        } else if self.counter == MAX_COUNTER {
            self.millis = self
                .millis
                .checked_add(1)
                .ok_or_else(|| "HLC milliseconds overflowed.".to_string())?;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        Hlc {
            millis: self.millis,
            counter: self.counter,
            device: device.to_string(),
        }
        .encode()
    }

    fn observe(&mut self, remote: &Hlc) {
        if (remote.millis, remote.counter) > (self.millis, self.counter) {
            self.millis = remote.millis;
            self.counter = remote.counter;
        }
    }
}

fn global_clock() -> &'static Mutex<HlcClock> {
    static CLOCK: OnceLock<Mutex<HlcClock>> = OnceLock::new();
    CLOCK.get_or_init(|| Mutex::new(HlcClock::default()))
}

fn lock_global_clock() -> MutexGuard<'static, HlcClock> {
    global_clock()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn global_clock_now_encoded(device: &str) -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let millis = u64::try_from(millis)
        .map_err(|_| "System time exceeds the HLC millisecond range.".to_string())?;
    lock_global_clock().now_at(millis, device)
}

pub(crate) fn observe(remote: &Hlc) {
    lock_global_clock().observe(remote);
}

fn register_hlc_function_with_device(
    connection: &Connection,
    device: String,
) -> rusqlite::Result<()> {
    connection.create_scalar_function("yona_hlc", 0, FunctionFlags::SQLITE_UTF8, move |_| {
        global_clock_now_encoded(&device).map_err(|message| {
            Error::UserFunctionError(Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                message,
            )))
        })
    })
}

pub(crate) fn register_placeholder_hlc_function(connection: &Connection) -> Result<(), String> {
    register_hlc_function_with_device(connection, "0000".to_string())
        .map_err(|error| format!("Could not configure the Notes HLC SQL function: {error}"))
}

pub(crate) fn register_hlc_function(connection: &Connection) -> Result<(), String> {
    let device_id = connection
        .query_row("SELECT device_id FROM sync_meta WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Could not read the Notes sync device ID: {error}"))?;
    let device = device_id
        .get(..DEVICE_WIDTH)
        .filter(|value| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| "The Notes sync device ID is invalid.".to_string())?;
    register_hlc_function_with_device(connection, device.to_string())
        .map_err(|error| format!("Could not configure the Notes HLC SQL function: {error}"))
}

pub(crate) fn restore_clock(connection: &Connection) -> Result<(), String> {
    let (millis, counter) = connection
        .query_row(
            "SELECT hlc_millis, hlc_counter FROM sync_meta WHERE id = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|error| format!("Could not read the persisted Notes HLC: {error}"))?;
    let millis = u64::try_from(millis)
        .map_err(|_| "The persisted Notes HLC milliseconds are invalid.".to_string())?;
    let counter = u32::try_from(counter)
        .map_err(|_| "The persisted Notes HLC counter is invalid.".to_string())?;
    if counter > MAX_COUNTER {
        return Err("The persisted Notes HLC counter is invalid.".to_string());
    }
    observe(&Hlc {
        millis,
        counter,
        device: "0000".to_string(),
    });
    let max_node_hlc = connection
        .query_row(
            "SELECT COALESCE(MAX(hlc), '') FROM notes_nodes",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not read the maximum Notes node HLC: {error}"))?;
    if !max_node_hlc.is_empty() {
        let remote = Hlc::decode(&max_node_hlc)
            .map_err(|error| format!("The maximum Notes node HLC is invalid: {error}"))?;
        observe(&remote);
    }
    Ok(())
}

pub(crate) fn persist_clock(connection: &Connection) -> Result<(), String> {
    let clock = lock_global_clock();
    let millis = i64::try_from(clock.millis)
        .map_err(|_| "The Notes HLC milliseconds cannot be persisted.".to_string())?;
    connection
        .execute(
            "UPDATE sync_meta SET hlc_millis = ?1, hlc_counter = ?2 WHERE id = 1",
            (millis, i64::from(clock.counter)),
        )
        .map_err(|error| format!("Could not persist the Notes HLC: {error}"))?;
    Ok(())
}

fn encode_base36(mut value: u64, width: usize) -> String {
    let mut bytes = vec![b'0'; width];
    for index in (0..width).rev() {
        let digit = (value % 36) as u8;
        bytes[index] = if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        };
        value /= 36;
    }
    String::from_utf8(bytes).expect("base36 output is ASCII")
}

fn decode_base36(value: &str) -> Result<u64, String> {
    value.bytes().try_fold(0_u64, |decoded, byte| {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte - b'0'),
            b'a'..=b'z' => u64::from(byte - b'a' + 10),
            _ => return Err("HLC base36 fields must use lowercase ASCII.".to_string()),
        };
        decoded
            .checked_mul(36)
            .and_then(|result| result.checked_add(digit))
            .ok_or_else(|| "HLC base36 value overflowed.".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        global_clock_now_encoded, observe, persist_clock, register_hlc_function, restore_clock,
        Hlc, HlcClock, MAX_COUNTER,
    };
    use rusqlite::{params, Connection};

    #[test]
    fn codec_round_trips_the_fixed_width_wire_format() {
        let encoded = "0swkd7qz3-01-a3f2";

        let decoded = Hlc::decode(encoded).expect("decode HLC");

        assert_eq!(decoded.encode().expect("encode HLC"), encoded);
        assert_eq!(encoded.len(), 17);
    }

    #[test]
    fn clock_is_monotonic_when_physical_time_stalls_or_moves_backward() {
        let mut clock = HlcClock::default();

        let first = clock.now_at(42, "a3f2").expect("first HLC");
        let same_millis = clock.now_at(42, "a3f2").expect("same-millis HLC");
        let backward = clock.now_at(41, "a3f2").expect("backward-clock HLC");

        assert!(first < same_millis);
        assert!(same_millis < backward);
    }

    #[test]
    fn clock_carries_counter_overflow_into_the_next_millisecond() {
        let mut clock = HlcClock {
            millis: 42,
            counter: MAX_COUNTER,
        };

        let next = clock.now_at(42, "a3f2").expect("overflow HLC");

        assert_eq!(next, "000000017-00-a3f2");
    }

    #[test]
    fn observing_remote_time_makes_the_next_local_hlc_greater() {
        let mut clock = HlcClock::default();
        let remote = Hlc {
            millis: 900,
            counter: 17,
            device: "beef".to_string(),
        };

        clock.observe(&remote);
        let local = clock.now_at(100, "a3f2").expect("post-observe HLC");

        assert!(local.as_str() > remote.encode().expect("remote encoding").as_str());
    }

    #[test]
    fn global_observe_advances_the_sql_clock_past_remote_time() {
        let remote = Hlc {
            millis: 90_000_000_000_000,
            counter: 41,
            device: "beef".to_string(),
        };

        observe(&remote);
        let local = global_clock_now_encoded("a3f2").expect("post-observe global HLC");

        assert!(local > remote.encode().expect("remote HLC"));
    }

    #[test]
    fn restoration_uses_persisted_and_node_maxima_and_persistence_saves_the_clock() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE sync_meta (\
                   id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, vault_uuid TEXT NOT NULL, \
                   hlc_millis INTEGER NOT NULL, hlc_counter INTEGER NOT NULL); \
                 CREATE TABLE notes_nodes (hlc TEXT NOT NULL);",
            )
            .expect("create HLC persistence fixture");
        connection
            .execute(
                "INSERT INTO sync_meta VALUES (1, ?1, ?2, ?3, ?4)",
                params![
                    "a3f20000-0000-4000-8000-000000000000",
                    "11111111-1111-4111-8111-111111111111",
                    100_000_000_000_000_i64,
                    10_i64
                ],
            )
            .expect("seed persisted clock");
        let node_max = Hlc {
            millis: 100_000_000_000_000,
            counter: 20,
            device: "beef".to_string(),
        }
        .encode()
        .expect("node max HLC");
        connection
            .execute(
                "INSERT INTO notes_nodes(hlc) VALUES (?1)",
                [node_max.as_str()],
            )
            .expect("seed node max");

        restore_clock(&connection).expect("restore global clock");
        register_hlc_function(&connection).expect("register SQL HLC");
        let issued: String = connection
            .query_row("SELECT yona_hlc()", [], |row| row.get(0))
            .expect("issue SQL HLC");
        persist_clock(&connection).expect("persist global clock");
        let persisted: (i64, i64) = connection
            .query_row(
                "SELECT hlc_millis, hlc_counter FROM sync_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read persisted global clock");
        let issued = Hlc::decode(&issued).expect("decode issued HLC");

        assert!(issued.encode().expect("issued HLC encoding") > node_max);
        assert_eq!(persisted, (issued.millis as i64, i64::from(issued.counter)));
    }

    #[test]
    fn lexical_order_matches_logical_order_for_representable_values() {
        let mut logical = Vec::new();
        for millis in [0, 1, 35, 36, 1_000_000, 99_999_999] {
            for counter in [0, 1, 35, 36, MAX_COUNTER] {
                for device in ["0000", "a3f2", "ffff"] {
                    let hlc = Hlc {
                        millis,
                        counter,
                        device: device.to_string(),
                    };
                    logical.push((millis, counter, device, hlc.encode().expect("encode HLC")));
                }
            }
        }

        let mut lexical = logical.clone();
        lexical.sort_by(|left, right| left.3.cmp(&right.3));
        logical.sort_by(|left, right| (left.0, left.1, left.2).cmp(&(right.0, right.1, right.2)));

        assert_eq!(lexical, logical);
    }

    #[test]
    fn codec_rejects_noncanonical_values() {
        for invalid in [
            "swkd7qz3-01-a3f2",
            "0SWKD7QZ3-01-a3f2",
            "0swkd7qz3-001-a3f2",
            "0swkd7qz3-01-zzzz",
            "00000000é-0-a3f2",
        ] {
            assert!(Hlc::decode(invalid).is_err(), "accepted {invalid}");
        }
    }
}
