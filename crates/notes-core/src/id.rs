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
mod yid_tests {
    use super::*;

    /// Twelve characters from the url-safe alphabet, every time. The id goes into
    /// a Markdown comment, a folder name and a SQLite key, and each of those has
    /// its own opinion about punctuation — this alphabet is the one all three
    /// accept without quoting.
    #[test]
    fn a_new_id_is_twelve_url_safe_characters() {
        for _ in 0..64 {
            let id = new_yid();

            assert_eq!(id.len(), YID_LENGTH, "{id}");
            assert!(is_yid(&id), "{id}");
            assert!(!id.contains('='), "there is nothing to pad: {id}");
        }
    }

    /// Nine bytes is three groups of three, so base64 has no leftover bits to
    /// pad and no partial group to bias. Every byte pattern reaches a distinct
    /// twelve characters, which is what lets the id be compared as a string
    /// anywhere without ever being decoded.
    #[test]
    fn nine_bytes_encode_without_padding_or_loss() {
        let mut seen = std::collections::BTreeSet::new();
        for byte in 0..=255u8 {
            let id = encode_yid(&[byte; 9]);
            assert_eq!(id.len(), YID_LENGTH, "{id}");
            assert!(seen.insert(id));
        }
        assert_eq!(seen.len(), 256, "two byte patterns landed on one id");

        assert_eq!(encode_yid(&[0; 9]), "AAAAAAAAAAAA");
        assert_eq!(encode_yid(&[255; 9]), "____________");
        // The two characters that make this alphabet url-safe, and the reason a
        // plain base64 encoder cannot stand in: `+` and `/` would both have to be
        // escaped in a folder name, and one of them is a path separator.
        let extremes = encode_yid(&[251, 255, 190, 251, 255, 190, 251, 255, 190]);
        assert!(
            extremes.contains('-') && extremes.contains('_'),
            "the bytes that reach the last two code points landed on {extremes}"
        );
        assert!(
            !extremes.contains('+') && !extremes.contains('/'),
            "{extremes}"
        );
    }

    /// A shape check at a trust boundary, and nothing more. Whether the vault
    /// already holds the id is a different question with a different answer.
    #[test]
    fn the_shape_check_refuses_what_the_vault_cannot_carry() {
        assert!(is_yid("Nd0000000001"));
        assert!(is_yid("-_aZ09-_aZ09"));

        assert!(!is_yid(""), "nothing is not an id");
        assert!(!is_yid("Nd000000001"), "eleven characters is not one");
        assert!(!is_yid("Nd00000000012"), "nor is thirteen");
        assert!(
            !is_yid("8a201f33-0000-4c91-8d02-000000000001"),
            "a uuid is the shape this replaces"
        );
        assert!(!is_yid("Nd000000000+"), "`+` is not url-safe");
        assert!(!is_yid("Nd000000000/"), "nor is `/`");
        assert!(!is_yid("Nd00000000 1"), "a space would end the token early");
        assert!(
            !is_yid("Nd0000000가"),
            "and the length is in characters, not bytes"
        );

        // Home is the one id in the format that is not random: it is reachable
        // before anything has been created, so it cannot be given a name.
        assert!(!is_yid(HOME_ID));
        assert!(is_block_id(HOME_ID));
        assert!(is_block_id("Nd0000000001"));
        assert!(!is_block_id("root2"));
    }
}
