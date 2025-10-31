use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderValue, Response, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::time::timeout;

use crate::{AppState, BackgroundAsset, BACKEND_PORT};

const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundLatestQuery {
    since: Option<u64>,
    wait: Option<bool>,
}

pub async fn run(state: Arc<AppState>) -> Result<(), String> {
    let router = Router::new()
        .route("/", get(root_health_check))
        .route("/background/latest", get(background_latest))
        .route("/internal/secrets/nanobanana", post(set_nanobanana_secret))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], BACKEND_PORT));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|err| format!("Failed to bind companion HTTP server: {err}"))?;

    println!("[HTTP] Companion API listening on http://{addr}");

    axum::serve(listener, router)
        .await
        .map_err(|err| format!("Companion HTTP server error: {err}"))
}

async fn background_latest(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BackgroundLatestQuery>,
) -> Result<Response<Body>, StatusCode> {
    let wait = params.wait.unwrap_or(false);
    let since = params.since.unwrap_or(0);

    loop {
        let (version, asset) = {
            let guard = state.background.lock().await;
            (guard.version, guard.asset.clone())
        };

        if version == 0 {
            if wait && wait_for_update(&state).await {
                continue;
            }
            return build_response(None, version, StatusCode::NO_CONTENT);
        }

        if version != since {
            if asset.is_some() {
                return build_response(asset, version, StatusCode::OK);
            } else {
                return build_response(None, version, StatusCode::NO_CONTENT);
            }
        }

        // We already have this version.
        if !wait {
            return build_response(None, version, StatusCode::NO_CONTENT);
        }

        if wait_for_update(&state).await {
            continue;
        } else {
            return build_response(None, version, StatusCode::NO_CONTENT);
        }
    }
}

async fn root_health_check() -> &'static str {
    "slowly unhinged tunnel working"
}

fn build_response(
    asset: Option<BackgroundAsset>,
    version: u64,
    status: StatusCode,
) -> Result<Response<Body>, StatusCode> {
    let mut builder = Response::builder().status(status);

    {
        let headers = builder
            .headers_mut()
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        headers.insert(
            "x-background-version",
            HeaderValue::from_str(&version.to_string())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("x-background-version,content-type"),
        );

        if let Some(ref asset) = asset {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&asset.mime)
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            );
        }
    }

    match asset {
        Some(asset) => builder
            .body(Body::from(asset.bytes))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
        None => builder
            .body(Body::empty())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn wait_for_update(state: &Arc<AppState>) -> bool {
    timeout(LONG_POLL_TIMEOUT, state.background_notify.notified())
        .await
        .is_ok()
}

#[derive(Deserialize)]
struct NanobananaSecretPayload {
    secret: String,
}

async fn set_nanobanana_secret(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NanobananaSecretPayload>,
) -> StatusCode {
    let sanitized = payload.secret.trim();
    if sanitized.is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    {
        let mut guard = state.nanobanana_secret.lock().await;
        guard.replace(sanitized.to_string());
    }

    StatusCode::NO_CONTENT
}
