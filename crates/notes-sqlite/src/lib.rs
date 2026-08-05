//! SQLite adapter and dedicated database worker for Notes.

mod export_snapshot;
#[cfg(feature = "bench-fixtures")]
mod fixtures;
mod forest_queries;
mod image_assets;
mod mutations;
mod queries;
mod repository;
mod row_mapping;
mod schema;
mod worker;

pub use image_assets::LocalImageAssets;
pub use worker::SqliteStorage;
