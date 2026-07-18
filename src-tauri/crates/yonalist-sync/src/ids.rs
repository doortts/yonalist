use std::{fmt, str::FromStr};

use uuid::Uuid;

use crate::SyncError;

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

fn encode_crockford(bytes: [u8; 16]) -> String {
    let mut value = u128::from_be_bytes(bytes);
    let mut output = [b'0'; 26];

    for character in output.iter_mut().rev() {
        *character = CROCKFORD[(value & 31) as usize];
        value >>= 5;
    }

    String::from_utf8(output.to_vec()).expect("Crockford alphabet is UTF-8")
}

fn decode_crockford(value: &str) -> Result<[u8; 16], SyncError> {
    if value.len() != 26 {
        return Err(SyncError::invalid_id(
            "invalid Crockford Base32 identifier length",
        ));
    }

    let mut decoded = 0_u128;
    for character in value.bytes() {
        let digit = match character.to_ascii_lowercase() {
            b'0' => 0,
            b'1' => 1,
            b'2' => 2,
            b'3' => 3,
            b'4' => 4,
            b'5' => 5,
            b'6' => 6,
            b'7' => 7,
            b'8' => 8,
            b'9' => 9,
            b'a' => 10,
            b'b' => 11,
            b'c' => 12,
            b'd' => 13,
            b'e' => 14,
            b'f' => 15,
            b'g' => 16,
            b'h' => 17,
            b'j' => 18,
            b'k' => 19,
            b'm' => 20,
            b'n' => 21,
            b'p' => 22,
            b'q' => 23,
            b'r' => 24,
            b's' => 25,
            b't' => 26,
            b'v' => 27,
            b'w' => 28,
            b'x' => 29,
            b'y' => 30,
            b'z' => 31,
            _ => return Err(SyncError::invalid_id("invalid Crockford Base32 identifier")),
        };
        decoded = decoded
            .checked_mul(32)
            .and_then(|number| number.checked_add(digit))
            .ok_or_else(|| SyncError::invalid_id("Crockford Base32 identifier is too large"))?;
    }

    Ok(decoded.to_be_bytes())
}

macro_rules! uuid_id {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(Uuid);

        impl $name {
            pub fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(Uuid::from_bytes(bytes))
            }

            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            pub fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&encode_crockford(*self.0.as_bytes()))
            }
        }

        impl FromStr for $name {
            type Err = SyncError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Ok(Self::from_bytes(decode_crockford(value)?))
            }
        }
    };
}

uuid_id!(ProjectId);
uuid_id!(MemberId);
uuid_id!(DeviceId);
uuid_id!(GrantId);
uuid_id!(EventId);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GitOid(String);

impl GitOid {
    pub fn parse(value: &str) -> Result<Self, SyncError> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            Ok(Self(value.to_owned()))
        } else {
            Err(SyncError::invalid_id(
                "Git object ID must be 64 lowercase hexadecimal characters",
            ))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Plane {
    Control,
    Data,
}

impl Plane {
    pub fn ref_prefix(self) -> &'static str {
        match self {
            Self::Control => "refs/yonalist/control/",
            Self::Data => "refs/yonalist/data/",
        }
    }
}
