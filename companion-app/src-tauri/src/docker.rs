use std::time::Duration;

use regex::Regex;
use testcontainers::{runners::AsyncRunner, GenericImage, ImageExt};
use tokio::time::sleep;

type CloudflaredContainer = testcontainers::ContainerAsync<GenericImage>;

pub async fn start_cloudflared(target_port: u16) -> Result<(CloudflaredContainer, String), String> {
    let image = GenericImage::new("cloudflare/cloudflared", "latest")
        .with_entrypoint("cloudflared")
        .with_cmd([
            "tunnel".to_string(),
            "--url".to_string(),
            format!("http://host.docker.internal:{target_port}"),
        ]);

    let container = image
        .start()
        .await
        .map_err(|err| format!("Failed to launch cloudflared: {err}"))?;

    let tunnel_url = wait_for_tunnel_url(&container).await?;
    Ok((container, tunnel_url))
}

pub async fn verify_cloudflared_container() -> Result<(), String> {
    let image = GenericImage::new("cloudflare/cloudflared", "latest")
        .with_entrypoint("cloudflared")
        .with_cmd(vec!["--version".to_string()]);

    let container = image
        .start()
        .await
        .map_err(|err| format!("Failed to start test cloudflared container: {err}"))?;

    // Give the container a brief moment to initialise.
    sleep(Duration::from_millis(500)).await;

    container
        .stop()
        .await
        .map_err(|err| format!("Failed to stop test cloudflared container: {err}"))?;

    Ok(())
}

async fn wait_for_tunnel_url(container: &CloudflaredContainer) -> Result<String, String> {
    let url_regex = Regex::new(r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)")
        .map_err(|err| err.to_string())?;

    let mut last_snapshot = String::new();

    for attempt in 0..60 {
        let stdout = container
            .stdout_to_vec()
            .await
            .map_err(|err| format!("Failed to read cloudflared stdout: {err}"))?;
        let stderr = container
            .stderr_to_vec()
            .await
            .map_err(|err| format!("Failed to read cloudflared stderr: {err}"))?;

        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );

        if let Some(capture) = url_regex.captures(&combined).and_then(|c| c.get(1)) {
            return Ok(capture.as_str().to_string());
        }

        if attempt == 0 || combined.len() != last_snapshot.len() {
            println!(
                "[cloudflared] Waiting for tunnel URL (attempt {}): {} bytes of logs.",
                attempt + 1,
                combined.len()
            );
            last_snapshot = combined;
        }

        sleep(Duration::from_millis(500)).await;
    }

    let stdout = container.stdout_to_vec().await.unwrap_or_default();
    let stderr = container.stderr_to_vec().await.unwrap_or_default();

    let mut combined = stdout;
    combined.extend_from_slice(&stderr);

    let tail = String::from_utf8_lossy(&combined);
    let snippet = if tail.len() > 512 {
        format!("{}…", &tail[..512])
    } else {
        tail.to_string()
    };

    Err(format!(
        "Timed out waiting for cloudflared tunnel URL. Latest logs:\n{}",
        snippet
    ))
}
