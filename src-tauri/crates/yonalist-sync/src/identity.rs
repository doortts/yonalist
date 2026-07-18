use ed25519_dalek::{Signer, SigningKey};

use crate::{atom::wire_from_unsigned, SignedAtom, SyncError, UnsignedAtom};

pub struct DeviceSigner(SigningKey);

impl DeviceSigner {
    pub fn from_secret_bytes(secret: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&secret))
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }

    pub fn sign(&self, mut atom: UnsignedAtom) -> Result<SignedAtom, SyncError> {
        atom.control_frontier
            .sort_by(|left, right| left.as_str().cmp(right.as_str()));
        atom.control_frontier.dedup();
        atom.data_frontier
            .sort_by(|left, right| left.as_str().cmp(right.as_str()));
        atom.data_frontier.dedup();
        let bytes = crate::atom::encode(&wire_from_unsigned(&atom))?;
        Ok(SignedAtom {
            unsigned: atom,
            signature: self.0.sign(&bytes).to_bytes().to_vec(),
        })
    }
}
