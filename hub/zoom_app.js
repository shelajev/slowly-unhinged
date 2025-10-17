const APP_VERSION = "0.1.0-debug.11";

const screenNameEl = document.getElementById("user-screen-name");
const agentTunnelEl = document.getElementById("agent-tunnel");
const activityLogEl = document.getElementById("activity-log");

function logMessage(message, level = "info") {
  if (!activityLogEl) {
    return;
  }
  const entry = document.createElement("li");
  const timestamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  entry.textContent = `[${APP_VERSION} ${timestamp}] ${message}`;
  entry.dataset.level = level;
  activityLogEl.prepend(entry);
}

function normalizeScreenName(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function updateScreenNameDisplay(text) {
  if (!screenNameEl) {
    return;
  }
  screenNameEl.textContent = text || "—";
}

function updateAgentTunnelDisplay(text) {
  if (!agentTunnelEl) {
    return;
  }
  agentTunnelEl.textContent = text || "—";
}

async function fetchAgentTunnel(normalizedScreenName) {
  const query = new URLSearchParams({ screenName: normalizedScreenName });
  updateAgentTunnelDisplay("Looking up…");
  try {
    const response = await fetch(`/api/get-agent-url?${query.toString()}`, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      const { tunnelUrl } = data;
      updateAgentTunnelDisplay(tunnelUrl);
      logMessage(`Agent tunnel resolved: ${tunnelUrl}`, "success");
      return tunnelUrl;
    }

    if (response.status === 404) {
      updateAgentTunnelDisplay("Not registered");
      logMessage(
        "No active agent registration found for this screen name.",
        "error",
      );
      return null;
    }

    const errorText = await response.text();
    updateAgentTunnelDisplay("Unavailable");
    logMessage(
      `Agent lookup failed: HTTP ${response.status} ${errorText}`,
      "error",
    );
    return null;
  } catch (error) {
    updateAgentTunnelDisplay("Unavailable");
    logMessage(`Agent lookup encountered an error: ${error.message}`, "error");
    return null;
  }
}

async function pollAgentTunnel(normalizedScreenName, attempt = 0) {
  const tunnelUrl = await fetchAgentTunnel(normalizedScreenName);
  if (tunnelUrl) {
    return tunnelUrl;
  }

  const backoffMs = Math.min(5_000, 250 * 2 ** attempt);
  const delayMs = Math.max(250, backoffMs);
  logMessage(
    `Agent tunnel not available (attempt ${attempt + 1}). Retrying in ${(delayMs / 1000).toFixed(2)}s…`,
  );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return pollAgentTunnel(normalizedScreenName, Math.min(attempt + 1, 7));
}

async function resolveScreenNameAndTunnel() {
  try {
    const userContext = await window.zoomSdk.getUserContext();
    logMessage(`User context: ${JSON.stringify(userContext)}`);

    const rawScreenName =
      userContext?.displayName ||
      userContext?.screenName ||
      userContext?.userName ||
      "";

    if (!rawScreenName) {
      updateScreenNameDisplay("Unavailable");
      logMessage("Zoom did not provide a screen name for this user.", "error");
      return;
    }

    updateScreenNameDisplay(rawScreenName);
    const normalized = normalizeScreenName(rawScreenName);
    if (!normalized) {
      logMessage(
        `Screen name "${rawScreenName}" collapsed to an empty identifier.`,
        "error",
      );
      return;
    }

    logMessage(
      `Resolved screen name "${rawScreenName}" → normalized "${normalized}".`,
    );
    return {
      raw: rawScreenName,
      normalized,
      tunnelUrl: await pollAgentTunnel(normalized),
    };
  } catch (error) {
    updateScreenNameDisplay("Unavailable");
    logMessage(
      `FAILED to get user context: ${JSON.stringify(error)}`,
      "error",
    );
    return null;
  }
}

async function pollBackgroundAndApply(screenName, backoffAttempt = 0, lastVersion = "0") {
  const baseDelay = 200;
  const maxDelay = 4_000;
  const backoffMs = Math.min(maxDelay, baseDelay * 2 ** backoffAttempt);
  const wait = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const params = new URLSearchParams({
    screenName,
    wait: "true",
    since: lastVersion,
    _: Date.now().toString(),
  });
  const requestUrl = `/api/background/latest?${params.toString()}`;

  try {
    const response = await fetch(requestUrl, {
      cache: "no-store",
    });

    if (response.status === 204) {
      logMessage("Background not yet available. Waiting for next version…");
      return pollBackgroundAndApply(screenName, 0, lastVersion);
    }

    if (response.status === 404) {
      logMessage(
        "Background service reports no active agent. Will retry shortly…",
        "error",
      );
      await wait(Math.max(500, backoffMs));
      return pollBackgroundAndApply(screenName, Math.min(backoffAttempt + 1, 7), lastVersion);
    }

    if (!response.ok) {
      const body = await response.text();
      logMessage(
        `Background fetch failed: HTTP ${response.status} ${body.slice(0, 120)}`,
        "error",
      );
      await wait(Math.max(500, backoffMs));
      return pollBackgroundAndApply(screenName, Math.min(backoffAttempt + 1, 7), lastVersion);
    }

    const version = response.headers.get("x-background-version") || lastVersion;
    const blob = await response.blob();
    const mimeType = blob.type || "image/png";
    const now = Date.now();

    const extension = mimeType.split("/")[1] ?? "png";
    const baseName = `goosehack-bg-${now}.${extension}`;

    if (!window.zoomSdk?.setVirtualBackground) {
      logMessage(
        "Zoom SDK does not expose setVirtualBackground in this environment.",
        "error",
      );
      await wait(Math.max(1_000, backoffMs));
      return pollBackgroundAndApply(screenName, Math.min(backoffAttempt + 1, 7), version);
    }

    const objectUrl = URL.createObjectURL(blob);

    try {
      await window.zoomSdk.setVirtualBackground({
        fileUrl: objectUrl,
        fileName: baseName,
      });
      logMessage(
        `Applied virtual background (version ${version}) via setVirtualBackground.`,
        "success",
      );
      return pollBackgroundAndApply(screenName, 0, version);
    } catch (error) {
      logMessage(
        `setVirtualBackground failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        "error",
      );
      await wait(Math.max(1_000, backoffMs));
      return pollBackgroundAndApply(screenName, Math.min(backoffAttempt + 1, 7), version);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (error) {
    logMessage(
      `Background polling error: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    await wait(Math.max(500, backoffMs));
    return pollBackgroundAndApply(screenName, Math.min(backoffAttempt + 1, 7), lastVersion);
  }
}

async function initializeZoomSdk() {
  logMessage("Configuring Zoom SDK...");
  try {
    const response = await window.zoomSdk.config({
      capabilities: [
        "getAppContext",
        "getRunningContext",
        "getUserContext",
        "mediaStream",
        "virtualBackground",
        "setVirtualBackground",
        "removeVirtualBackground",
      ],
    });
    logMessage("zoomSdk.config success: " + JSON.stringify(response));

    try {
      const context = await window.zoomSdk.getAppContext();
      logMessage("App context: " + JSON.stringify(context));
    } catch (error) {
      logMessage(
        "FAILED to get app context: " + JSON.stringify(error),
        "error",
      );
    }

    const resolved = await resolveScreenNameAndTunnel();
    if (!resolved) {
      return;
    }

    const { normalized } = resolved;
    if (normalized) {
      void pollBackgroundAndApply(normalized);
    }
  } catch (error) {
    logMessage("FAILED to config: " + JSON.stringify(error), "error");
  }
}

logMessage("Zoom Companion UI booting…");

if (window.zoomSdk?.config) {
  void initializeZoomSdk();
} else {
  logMessage(
    "Zoom SDK is not available in this environment.",
    "error",
  );
  updateScreenNameDisplay("Unavailable");
  updateAgentTunnelDisplay("Unavailable");
}
