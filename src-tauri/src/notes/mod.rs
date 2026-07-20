pub(crate) mod attachment_ingest;
pub(crate) mod attachments;
pub(crate) mod commands;
pub(crate) mod connection;
pub(crate) mod date_index;
pub(crate) mod error;
pub(crate) mod export;
pub(crate) mod history;
pub(crate) mod hlc;
pub(crate) mod image_atom;
pub(crate) mod markdown_import;
#[cfg(test)]
mod performance;
pub(crate) mod repository;
pub(crate) mod schema;
// Phase 1 wires pure file-format types ahead of the later runtime phases.
#[allow(dead_code)]
pub(crate) mod sync;
pub(crate) mod tags;
pub(crate) mod types;
