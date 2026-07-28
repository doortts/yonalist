//! SQLite adapter and dedicated database worker for Notes.

#[cfg(feature = "bench-fixtures")]
mod fixtures;
mod forest_queries;
mod mutations;
mod queries;
mod repository;
mod row_mapping;
mod schema;
mod worker;

pub use worker::SqliteStorage;
