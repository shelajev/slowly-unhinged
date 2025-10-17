use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{env, fs, io::ErrorKind, path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, State};
use testcontainers::{ContainerAsync, GenericImage};
use tokio::{
    sync::{Mutex, Notify},
    time::sleep,
};

mod docker;
mod web_server;

// --- Tauri State Management ---

type ManagedContainer = ContainerAsync<GenericImage>;

#[derive(Clone)]
pub(crate) struct BackgroundAsset {
    bytes: Vec<u8>,
    mime: String,
}

struct BackgroundState {
    version: u64,
    asset: Option<BackgroundAsset>,
}

pub struct AppState {
    pub(crate) cloudflared_container: Mutex<Option<ManagedContainer>>,
    pub(crate) background: Mutex<BackgroundState>,
    pub(crate) background_notify: Notify,
    pub(crate) nanobanana_secret: Mutex<Option<String>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            cloudflared_container: Mutex::new(None),
            background: Mutex::new(BackgroundState {
                version: 0,
                asset: None,
            }),
            background_notify: Notify::new(),
            nanobanana_secret: Mutex::new(None),
        }
    }
}

// --- Testcontainers Logic ---

const HUB_URL: &str = "https://slowlyunhinged-hub-54127830651.us-central1.run.app";
const DMR_BASE_URL: &str = "http://localhost:12434";
const DEFAULT_TRANSCRIPTION_MODEL_ID: &str = "hf.co/ggml-org/ultravox-v0_5-llama-3_1-8b-gguf";
const DEFAULT_BACKGROUND_PROMPT_MODEL_ID: &str = "hf.co/unsloth/gemma-3n-e2b-it-gguf:q8_k_xl";
const BACKEND_PORT: u16 = 41786;const DMR_WARMUP_ATTEMPTS: usize = 10;
const DMR_WARMUP_DELAY_MS: u64 = 1_000;
const DMR_MODEL_POLL_ATTEMPTS: usize = 60;
const DMR_MODEL_POLL_DELAY_MS: u64 = 5_000;
const NANO_BANANA_MODEL: &str = "gemini-2.5-flash-image";
const NANO_BANANA_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const NANO_BANANA_FALLBACK_MIME: &str = "image/png";
const NANO_BANANA_ASPECT_RATIO: &str = "16:9";

#[derive(Deserialize)]
struct DmrModelEntry {
    tags: Option<Vec<String>>,
}

async fn list_dmr_models(client: &reqwest::Client) -> Result<Vec<DmrModelEntry>, String> {
    let url = format!("{DMR_BASE_URL}/models");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("Failed to query Docker Model Runner: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unable to read response body>".to_string());
        return Err(format!(
            "DMR model list request failed: HTTP {status} - {body}"
        ));
    }

    response
        .json::<Vec<DmrModelEntry>>()
        .await
        .map_err(|err| format!("Failed to parse DMR model list: {err}"))
}

fn contains_model(models: &[DmrModelEntry], model_id: &str) -> bool {
    models.iter().any(|entry| {
        entry
            .tags
            .as_ref()
            .map(|tags| tags.iter().any(|tag| tag == model_id))
            .unwrap_or(false)
    })
}

fn missing_models(models: &[DmrModelEntry], required_models: &[String]) -> Vec<String> {
    required_models
        .iter()
        .filter(|model| !contains_model(models, model))
        .cloned()
        .collect()
}

async fn wait_for_dmr_readiness(client: &reqwest::Client) -> Result<(), String> {
    for attempt in 0..DMR_WARMUP_ATTEMPTS {
        match list_dmr_models(client).await {
            Ok(_) => return Ok(()),
            Err(err) if attempt + 1 < DMR_WARMUP_ATTEMPTS => {
                println!(
                    "[DMR] Model list probe failed (attempt {}): {err}",
                    attempt + 1
                );
                sleep(Duration::from_millis(DMR_WARMUP_DELAY_MS)).await;
            }
            Err(err) => return Err(err),
        }
    }

    Err("Timed out waiting for Docker Model Runner to respond.".to_string())
}

async fn ensure_required_models(client: &reqwest::Client, settings: &Settings) -> Result<(), String> {
    wait_for_dmr_readiness(client).await?;

    let mut models = list_dmr_models(client).await?;
    let required_models = vec![
        settings.model_transcription.clone().unwrap_or_default(),
        settings.model_prompt.clone().unwrap_or_default(),
    ];
    let mut pending = missing_models(&models, &required_models);
    if pending.is_empty() {
        println!("[DMR] All required models are already available.");
        return Ok(());
    }

    let create_url = format!("{DMR_BASE_URL}/models/create");
    println!(
        "[DMR] Missing models: {}. Requesting downloads via {create_url}.",
        pending.join(", ")
    );

    for model in &pending {
        let response = client
            .post(&create_url)
            .json(&serde_json::json!({ "from": model }))
            .send()
            .await
            .map_err(|err| format!("Failed to request download for model \"{model}\": {err}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unable to read response body>".to_string());
            return Err(format!(
                "Model download request for \"{model}\" failed: HTTP {status} - {body}"
            ));
        }
    }

    println!("[DMR] Download requests accepted. Polling for model availability…");

    for attempt in 0..DMR_MODEL_POLL_ATTEMPTS {
        sleep(Duration::from_millis(DMR_MODEL_POLL_DELAY_MS)).await;
        models = list_dmr_models(client).await?;
        pending.retain(|model| !contains_model(&models, model));
        if pending.is_empty() {
            println!(
                "[DMR] All required models are available after {} poll attempts.",
                attempt + 1
            );
            return Ok(());
        }
        println!(
            "[DMR] Waiting for models to download (attempt {}): pending {}",
            attempt + 1,
            pending.join(", ")
        );
    }

    Err(format!(
        "Timed out waiting for required models to become available: {}",
        pending.join(", ")
    ))
}

async fn start_and_register_agent(
    app: &AppHandle,
    screen_name: &str,
    app_state: &Arc<AppState>,
) -> Result<String, String> {
    let http_client = reqwest::Client::new();
    let settings = load_settings(app)?;

    ensure_required_models(&http_client, &settings).await?;

    let (cloudflared_container, tunnel_url) = docker::start_cloudflared(BACKEND_PORT).await?;

    let mut guard = app_state.cloudflared_container.lock().await;
    *guard = Some(cloudflared_container);
    drop(guard);

    let hub_api_url = format!("{}/api/register-agent", HUB_URL);
    let sanitized_screen_name = screen_name.trim();
    if sanitized_screen_name.is_empty() {
        return Err("Screen name must not be empty.".to_string());
    }
    let has_local_nanobanana_key = has_local_nanobanana_key(app)?;
    let requires_nanobanana_key = true;
    let payload = RegisterAgentPayload {
        screen_name: sanitized_screen_name,
        tunnel_url: &tunnel_url,
        requires_nanobanana_key,
        has_local_nanobanana_key,
    };
    let res = http_client.post(&hub_api_url).json(&payload).send().await;

    match res {
        Ok(response) if response.status().is_success() => {
            Ok(format!("Agent registered with tunnel: {}", tunnel_url))
        }
        Ok(response) => Err(format!(
            "Failed to register agent: {}",
            response.text().await.unwrap_or_default()
        )),
        Err(err) => Err(format!("Request to Hub failed: {}", err)),
    }
}

// --- Tauri Commands ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterAgentPayload<'a> {
    screen_name: &'a str,
    tunnel_url: &'a str,
    requires_nanobanana_key: bool,
    has_local_nanobanana_key: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WheelState {
    positions: Vec<usize>,
    active_index: usize,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    wheels: Option<WheelState>,
    #[serde(default)]
    nanobanana_api_key: Option<String>,
    #[serde(default)]
    model_transcription: Option<String>,
    #[serde(default)]
    model_prompt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundImageResult {
    data_url: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to resolve config directory: {err}"))?;

    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create config directory: {err}"))?;

    dir.push("settings.json");
    Ok(dir)
}

fn legacy_wheel_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to resolve config directory: {err}"))?;

    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create config directory: {err}"))?;

    dir.push("wheel_state.json");
    Ok(dir)
}

fn nanobanana_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to resolve config directory: {err}"))?;

    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create config directory: {err}"))?;

    dir.push("nanobanana_api_key.txt");
    Ok(dir)
}

fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => {
            let mut settings: Settings = serde_json::from_str(&contents)
                .map_err(|err| format!("Failed to parse settings: {err}"))?;

            let mut needs_save = false;
            if settings.model_transcription.is_none() {
                settings.model_transcription = Some(DEFAULT_TRANSCRIPTION_MODEL_ID.to_string());
                needs_save = true;
            }
            if settings.model_prompt.is_none() {
                settings.model_prompt = Some(DEFAULT_BACKGROUND_PROMPT_MODEL_ID.to_string());
                needs_save = true;
            }

            if needs_save {
                save_settings(app, &settings)?;
            }

            Ok(settings)
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let mut settings = if let Some(settings) = migrate_legacy_wheel_state(app)? {
                if let Ok(legacy_path) = legacy_wheel_state_path(app) {
                    let _ = fs::remove_file(legacy_path);
                }
                settings
            } else {
                Settings::default()
            };

            settings.model_transcription = Some(DEFAULT_TRANSCRIPTION_MODEL_ID.to_string());
            settings.model_prompt = Some(DEFAULT_BACKGROUND_PROMPT_MODEL_ID.to_string());
            save_settings(app, &settings)?;

            Ok(settings)
        }
        Err(err) => Err(format!("Failed to read settings: {err}")),
    }
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let contents = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;
    fs::write(&path, contents).map_err(|err| format!("Failed to write settings: {err}"))?;
    Ok(())
}

fn migrate_legacy_wheel_state(app: &AppHandle) -> Result<Option<Settings>, String> {
    let legacy_path = legacy_wheel_state_path(app)?;
    match fs::read_to_string(&legacy_path) {
        Ok(contents) => {
            let wheels: WheelState = serde_json::from_str(&contents)
                .map_err(|err| format!("Failed to parse legacy wheel state: {err}"))?;
            Ok(Some(Settings {
                wheels: Some(wheels),
                ..Default::default()
            }))
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Failed to read legacy wheel state: {err}")),
    }
}

fn has_local_nanobanana_key(app: &AppHandle) -> Result<bool, String> {
    let settings = load_settings(app)?;
    if settings
        .nanobanana_api_key
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(true);
    }

    if let Ok(value) = env::var("NANOBANANA_API_KEY") {
        if !value.trim().is_empty() {
            return Ok(true);
        }
    }

    let path = nanobanana_key_path(app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(!contents.trim().is_empty()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!(
            "Failed to read nano banana API key from \"{}\": {err}",
            path.display()
        )),
    }
}

async fn load_nanobanana_api_key(app: &AppHandle, state: &Arc<AppState>) -> Result<String, String> {
    let settings = load_settings(app)?;
    if let Some(value) = settings
        .nanobanana_api_key
        .as_ref()
        .map(|value| value.trim())
        .filter(|trimmed| !trimmed.is_empty())
    {
        return Ok(value.to_string());
    }

    if let Ok(value) = env::var("NANOBANANA_API_KEY") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    if let Some(value) = {
        let guard = state.nanobanana_secret.lock().await;
        guard.clone()
    } {
        return Ok(value);
    }

    let settings_file = settings_path(app)?;
    let path = nanobanana_key_path(app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => {
            let trimmed = contents.trim();
            if trimmed.is_empty() {
                Err(format!(
                    "Nano banana API key file at \"{}\" is empty.",
                    path.display()
                ))
            } else {
                Ok(trimmed.to_string())
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Err(format!(
            "Nano banana API key not configured. \
             Provide one by setting \"nanobananaApiKey\" in \"{}\", \
             exporting the NANOBANANA_API_KEY environment variable, \
             placing the key in \"{}\", \
             or ensuring the Hub delivers a default key.",
            settings_file.display(),
            path.display()
        )),
        Err(err) => Err(format!(
            "Failed to read nano banana API key from \"{}\": {err}",
            path.display()
        )),
    }
}

fn extract_base64_image(value: &serde_json::Value) -> Option<(String, Option<String>)> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(inline_data) = map.get("inlineData") {
                if let Some(result) = extract_base64_image(inline_data) {
                    return Some(result);
                }
            }

            for key in ["data", "bytesBase64", "b64_json"] {
                if let Some(serde_json::Value::String(data)) = map.get(key) {
                    let trimmed = data.trim();
                    if trimmed.len() > 32 && BASE64_STANDARD.decode(trimmed).is_ok() {
                        let mime = map
                            .get("mimeType")
                            .and_then(|mime| mime.as_str())
                            .map(|mime| mime.to_string());
                        return Some((trimmed.to_string(), mime));
                    }
                }
            }

            for value in map.values() {
                if let Some(result) = extract_base64_image(value) {
                    return Some(result);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(result) = extract_base64_image(item) {
                    return Some(result);
                }
            }
            None
        }
        _ => None,
    }
}

#[tauri::command]
async fn register_agent(
    app: AppHandle,
    screen_name: &str,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    start_and_register_agent(&app, screen_name, state.inner()).await
}

#[tauri::command]
async fn check_docker_access() -> Result<(), String> {
    docker::verify_cloudflared_container().await
}

#[tauri::command]
async fn ensure_models_ready(app: AppHandle) -> Result<(), String> {
    let client = reqwest::Client::new();
    let settings = load_settings(&app)?;
    ensure_required_models(&client, &settings).await
}

#[tauri::command]
async fn stop_agent(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let container = {
        let mut guard = state.cloudflared_container.lock().await;
        guard.take()
    };

    match container {
        Some(container) => {
            if let Err(err) = container.stop().await {
                Err(format!("Failed to stop agent container: {err}"))
            } else {
                {
                    let mut guard = state.nanobanana_secret.lock().await;
                    guard.take();
                }
                Ok("Agent stopped successfully.".to_string())
            }
        }
        None => Err("Agent not running.".to_string()),
    }
}

#[tauri::command]
async fn save_wheel_state(app: AppHandle, state: WheelState) -> Result<(), String> {
    let mut settings = load_settings(&app)?;
    settings.wheels = Some(state);
    save_settings(&app, &settings)
}

#[tauri::command]
async fn load_wheel_state(app: AppHandle) -> Result<Option<WheelState>, String> {
    let settings = load_settings(&app)?;
    Ok(settings.wheels)
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    load_settings(&app)
}

#[tauri::command]
async fn generate_background_image(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    prompt: String,
) -> Result<BackgroundImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt must not be empty.".to_string());
    }

    let api_key = load_nanobanana_api_key(&app, state.inner()).await?;

    let url = format!(
        "{}/{NANO_BANANA_MODEL}:generateContent",
        NANO_BANANA_ENDPOINT
    );

    let last_asset = {
        let guard = state.background.lock().await;
        guard.asset.clone()
    };

    let mut parts = vec![serde_json::json!({ "text": prompt })];
    if let Some(asset) = last_asset {
        parts.push(serde_json::json!({
            "inlineData": {
                "mimeType": asset.mime,
                "data": BASE64_STANDARD.encode(&asset.bytes)
            }
        }));
    }

    let body = serde_json::json!({
        "contents": [{"parts": parts}],
        "generationConfig": {
            "imageConfig": {
                "aspectRatio": NANO_BANANA_ASPECT_RATIO
            }
        }
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Goog-Api-Key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Nano banana request failed: {err}"))?;

    let status = response.status();
    let raw_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read nano banana response: {err}"))?;

    if !status.is_success() {
        let mut snippet = String::new();
        let mut truncated = false;
        for (index, ch) in raw_body.chars().enumerate() {
            if index >= 512 {
                truncated = true;
                break;
            }
            snippet.push(ch);
        }
        if truncated {
            snippet.push('…');
        }
        return Err(format!(
            "Nano banana request failed: HTTP {status} - {snippet}"
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&raw_body)
        .map_err(|err| format!("Failed to parse nano banana response: {err}"))?;

    let (image_base64, mime) = extract_base64_image(&parsed)
        .map(|(data, mime)| {
            (
                data,
                mime.unwrap_or_else(|| NANO_BANANA_FALLBACK_MIME.to_string()),
            )
        })
        .ok_or_else(|| {
            "Nano banana response did not contain image data. Check logs for raw response."
                .to_string()
        })?;

    let image_bytes = BASE64_STANDARD
        .decode(&image_base64)
        .map_err(|err| format!("Failed to decode image data: {err}"))?;

    {
        let mut guard = state.background.lock().await;
        guard.asset = Some(BackgroundAsset {
            bytes: image_bytes,
            mime: mime.clone(),
        });
        guard.version = guard.version.wrapping_add(1);
    }

    state.background_notify.notify_waiters();

    let data_url = format!("data:{};base64,{}", mime, image_base64);

    Ok(BackgroundImageResult { data_url })
}

// --- Application Setup ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let shared_state = Arc::new(AppState::new());

    tauri::Builder::default()
        .manage(shared_state.clone())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {            let state = app.state::<Arc<AppState>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = web_server::run(state).await {
                    eprintln!("[HTTP] Companion API server terminated: {err}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_agent,
            check_docker_access,
            ensure_models_ready,
            stop_agent,
            save_wheel_state,
            load_wheel_state,
            get_settings,
            generate_background_image
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
