//! SQLite adapter and dedicated database worker for Notes.

mod attachment_list;
mod export_snapshot;
#[cfg(feature = "bench-fixtures")]
mod fixtures;
mod forest_queries;
mod image_assets;
mod mutations;
mod node_paths;
mod queries;
mod repository;
mod row_mapping;
mod schema;
mod seed;
mod sync_merge;
mod worker;

pub use image_assets::LocalImageAssets;
/// The DDL this build was written against. Tests that need to stand a
/// different shape up read it from here rather than keeping a copy.
pub use schema::SCHEMA_SQL;
pub use worker::SqliteStorage;
