use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

use crate::DomainError;

const MAX_NODE_ID_BYTES: usize = 128;

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
