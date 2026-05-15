use std::sync::Arc;

use dotenvy::dotenv_override;
use orloj_backend_rust::{
    db::DbPool,
    server::{AppState, SharedState, build_entry, build_native_entry, entry_name, native_entry_name, new_registry, router},
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

    // Pre-warm the registry from all persisted entries (contracts + native chains).
    let registry = new_registry();

    let rows = match db.load_all_contracts().await {
        Ok(r) => {
            eprintln!("[startup] {} row(s) found in registered_contracts", r.len());
            r
        }
        Err(e) => {
            eprintln!("[startup] load_all_contracts failed: {e:#}");
            vec![]
        }
    };

    let mut loaded = 0usize;
    for row in rows {
        if row.address == "native" {
            let name = native_entry_name(row.chain_id);
            let entry = build_native_entry(row.chain_id, row.rpc_url);
            eprintln!("[startup] native  {name}");
            registry.set(name, entry).await;
            loaded += 1;
        } else {
            let name = entry_name(row.chain_id, &row.address);
            match build_entry(
                row.chain_id,
                &row.address,
                row.abi,
                row.contract_name,
                row.implementation,
                row.rpc_url,
            ) {
                Ok(entry) => {
                    eprintln!("[startup] contract {name}");
                    registry.set(name, entry).await;
                    loaded += 1;
                }
                Err(e) => eprintln!("[startup] skipping {name}: {e:#}"),
            }
        }
    }

    eprintln!("[registry] loaded {loaded} entries");

    // Evict entries idle for > 30 min (checked every 60 s).
    registry.spawn_eviction_task();

    let state: SharedState = Arc::new(AppState { registry, db });
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    eprintln!("[registry] listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
