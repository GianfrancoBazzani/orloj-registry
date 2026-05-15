use std::sync::Arc;

use dotenvy::dotenv_override;
use orloj_backend_rust::{
    db::DbPool,
    server::{AppState, SharedState, new_registry, router},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match dotenv_override() {
        Ok(path) => eprintln!("[env] loaded .env from {}", path.display()),
        Err(e) => eprintln!("[env] .env not loaded: {e}"),
    }

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);

    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();

    eprintln!("[db] connecting to {db_url}");
    let db = Arc::new(DbPool::connect(&db_url).await?);
    db.ensure_tables().await?;

    let registry = new_registry();
    registry.spawn_eviction_task();

    let state: SharedState = Arc::new(AppState { registry, db });
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    eprintln!("[registry] listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
