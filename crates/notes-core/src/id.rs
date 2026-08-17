use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

use crate::DomainError;

const MAX_NODE_ID_BYTES: usize = 128;

/// The permanent block id every bullet carries, in the vault and in the
/// database alike. Twelve base64url characters, which is exactly nine bytes:
/// the encoding is a bijection there, so there is no padding to strip and no
/// modulo bias to correct for.
pub const YID_LENGTH: usize = 12;
const YID_BYTES: usize = 9;

/// The one id in the whole format that is not a `yid`. Home is reachable
/// before anything has been created, so it cannot be given a random name.
pub const HOME_ID: &str = "root";

pub fn new_yid() -> String {
    let mut bytes = [0u8; YID_BYTES];
    getrandom::fill(&mut bytes).expect("the OS random source");
    encode_yid(&bytes)
}

/// Nine bytes to twelve characters. Callers deriving an id — a duplicated
/// subtree, a recovery page — hand their own bytes in so that the same input
/// always lands on the same id.
pub fn encode_yid(bytes: &[u8; YID_BYTES]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// File input is a trust boundary, so this is a shape check and nothing more.
/// Whether the vault already holds this id is a separate question with a
/// separate answer.
pub fn is_yid(value: &str) -> bool {
    value.len() == YID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// What may stand where a block id is expected: a `yid`, or home's literal.
pub fn is_block_id(value: &str) -> bool {
    value == HOME_ID || is_yid(value)
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct NodeId(String);

impl NodeId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for NodeId {
    type Error = DomainError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl TryFrom<String> for NodeId {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > MAX_NODE_ID_BYTES
            || value.chars().any(char::is_control)
        {
            return Err(DomainError::InvalidNodeId);
        }
        Ok(Self(value))
    }
}

impl Display for NodeId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_id_is_twelve_url_safe_characters() {
        for _ in 0..64 {
            let id = new_yid();
            assert_eq!(id.len(), YID_LENGTH, "{id}");
            assert!(is_yid(&id), "{id} is not a yid");
        }
    }

    #[test]
    fn nine_bytes_encode_without_padding_or_loss() {
        assert_eq!(encode_yid(&[0; 9]), "AAAAAAAAAAAA");
        assert_eq!(encode_yid(&[255; 9]), "____________");
        // Every distinct input has a distinct id: nine bytes is twelve base64
        // characters exactly, so nothing is truncated away.
        let mut seen = std::collections::BTreeSet::new();
        for byte in 0..=255u8 {
            let mut bytes = [0u8; 9];
            bytes[8] = byte;
            assert!(seen.insert(encode_yid(&bytes)), "{byte} collided");
        }
    }

    #[test]
    fn the_shape_check_refuses_what_the_vault_cannot_carry() {
        assert!(!is_yid(""));
        assert!(!is_yid("short"));
        assert!(!is_yid("thirteenchars"));
        assert!(!is_yid("has spaces!!"));
        assert!(!is_yid("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1"));
        assert!(!is_yid(HOME_ID));
        assert!(is_block_id(HOME_ID));
        assert!(is_yid("Df4qM9_wK2Ls"));
        assert!(is_yid("------------"));
    }
}
