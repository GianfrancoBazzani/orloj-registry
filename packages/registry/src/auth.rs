// Mirrors orloj-registry/packages/registry/src/auth.mjs
//
// requireBearer → require_bearer()
//   Missing header  → 401, WWW-Authenticate: Bearer realm="orloj-registry"
//                         { error: "unauthorized" }
//   Bad/invalid     → 401, WWW-Authenticate: Bearer realm="orloj-registry", error="invalid_token"
//                         { error: "invalid_token" }
//   DB error        → 500, { error: "internal error" }
//   Success         → agent_id: String

use axum::{
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
};
use serde_json::json;

use crate::db::DbPool;

const REALM: &str = r#"Bearer realm="orloj-registry""#;
const REALM_INVALID: &str = r#"Bearer realm="orloj-registry", error="invalid_token""#;

/// Extract, validate, and DB-verify a Bearer token.
///
/// Returns `Ok(agent_id)` on success, or `Err(Response)` containing the
/// ready-to-send HTTP response that the caller should return immediately.
///
/// Mirrors `requireBearer` in auth.mjs.
pub async fn require_bearer(headers: &HeaderMap, db: &DbPool) -> Result<String, Response> {
    let auth_header = match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some(h) => h,
        _none => return Err(www_auth_response(StatusCode::UNAUTHORIZED, REALM, "unauthorized")),
    };

    let token = match parse_bearer(auth_header) {
        Some(t) => t,
        None => {
            return Err(www_auth_response(
                StatusCode::UNAUTHORIZED,
                REALM_INVALID,
                "invalid_token",
            ));
        }
    };

    match db.lookup_token(&token).await {

        Ok(Some(agent_id)) => Ok(agent_id),
        Ok(_none) => Err(www_auth_response(
            StatusCode::UNAUTHORIZED,
            REALM_INVALID,
            "invalid_token",
        )),
        Err(e) => {
            eprintln!(
        "[auth] lookup failed: {e:#}");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response())
        }
    }
}

/// Parse the token out of a `Bearer <token>` Authorization header value.
///
/// Mirrors `/^Bearer\s+(.+)$/i` + `match[1].trim()` from auth.mjs:
///   - Case-insensitive "Bearer" prefix
///   - One or more ASCII whitespace chars required after "Bearer"
///   - Token is trimmed of surrounding whitespace
fn parse_bearer(header: &str) -> Option<String> {
    let bytes = header.as_bytes();
    // "Bearer" is 6 bytes; must be followed by at least one whitespace char.
    if bytes.len() < 8 {
        return None;
    }
    if !bytes[..6].eq_ignore_ascii_case(b"bearer") {
        return None;
    }
    let after = &header[6..];
    // Must start with whitespace (\s+).
    if !after.starts_with(|c: char| c.is_ascii_whitespace()) {
        return None;
    }
    let token = after
        .trim_start_matches(|c: char| c.is_ascii_whitespace())
        .trim(); // mirrors match[1].trim() in JS
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Build a 401 response with a `WWW-Authenticate` header and a JSON body.
fn www_auth_response(status: StatusCode, www_auth: &'static str, error: &'static str) -> Response {
    let mut resp = (status, Json(json!({ "error": error }))).into_response();
    resp.headers_mut().insert(
        "www-authenticate",
        HeaderValue::from_static(www_auth),
    );
    resp
}
