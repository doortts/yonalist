//! The vault side of Notes: the markdown format, the clock its merges order
//! by, and the atomic writes that put documents on disk.
//!
//! This crate is a library over a `rusqlite::Connection` and nothing more. It
//! owns no thread, opens no database and knows nothing of Tauri: `notes-sqlite`
//! calls it from inside the single worker that owns the connection, and the
//! desktop adapter owns the lifetimes above that.

pub mod debounce;
pub mod document;
pub mod export;
pub mod file_io;
pub mod hlc;
pub mod layout;
pub mod merger;
pub mod parse;
pub mod render;
