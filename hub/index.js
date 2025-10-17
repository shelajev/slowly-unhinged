const express = require("express");
const path = require("path");
const { Firestore, Timestamp } = require("@google-cloud/firestore");
const axios = require("axios");

// --- Credentials ---
const zoomClientId = process.env.ZOOM_CLIENT_ID;
const zoomClientSecret = process.env.ZOOM_CLIENT_SECRET;

// --- DEBUGGING: Log credentials to verify they are loaded ---
console.log(
  `[Hub-Debug] ZOOM_CLIENT_ID: ${zoomClientId ? "Loaded" : "MISSING"}`,
);
console.log(
  `[Hub-Debug] ZOOM_CLIENT_SECRET: ${zoomClientSecret ? "Loaded" : "MISSING"}`,
);
if (zoomClientSecret) {
  console.log(
    `[Hub-Debug] ZOOM_CLIENT_SECRET (first 4 chars): ${zoomClientSecret.substring(
      0,
      4,
    )}`,
  );
}
console.log(
  `[Hub] Default nanobanana key configured: ${hasDefaultNanobananaKey() ? "yes" : "no"}`,
);

// --- App Setup ---
const app = express();
const port = process.env.PORT || 8080;
const firestore = new Firestore();
const AGENT_URL_TTL_MINUTES = 5;
const BACKGROUND_PROXY_TIMEOUT_MS = 35_000;
const BACKGROUND_PROXY_RETRIES = 3;

app.use(express.json());
app.use(express.static(__dirname));

const cspDirectives = [
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
  "frame-ancestors 'self' https://*.zoom.us https://*.zoomgov.com",
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", cspDirectives);
  next();
});

// --- API Endpoints ---
function normalizeScreenName(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDefaultNanobananaKey() {
  const fromHub = process.env.HUB_NANOBANANA_API_KEY;
  if (fromHub && fromHub.trim()) {
    return true;
  }
  const fallback = process.env.NANOBANANA_API_KEY;
  return Boolean(fallback && fallback.trim());
}

async function deliverDefaultNanobananaKey(tunnelUrl) {
  const secret =
    process.env.HUB_NANOBANANA_API_KEY?.trim() ||
    process.env.NANOBANANA_API_KEY?.trim();
  if (!secret) {
    throw new Error("Default nanobanana key is not configured on the Hub.");
  }

  const tunnelBase = tunnelUrl.replace(/\/$/, "");
  const requestUrl = `${tunnelBase}/internal/secrets/nanobanana`;

  const maxAttempts = 15;
  let attempt = 0;
  let lastError;

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  while (attempt < maxAttempts) {
    try {
      await axios.post(
        requestUrl,
        { secret },
        {
          timeout: 12_000,
        },
      );
      console.log(
        `[Hub] Default nanobanana key delivered to ${tunnelBase}/internal/secrets/nanobanana (attempt ${attempt + 1})`,
      );
      return;
    } catch (error) {
      lastError = error;
      attempt += 1;
      const delayMs = Math.min(12_000, 1_000 * attempt);
      console.warn(`[Hub] Attempt ${attempt} to deliver tunnel secret failed.`);
      if (attempt >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error("Unknown error delivering default nanobanana key.");
}

async function getActiveAgent(normalizedScreenName) {
  if (!normalizedScreenName) {
    return null;
  }

  const agentRef = firestore.collection("agents").doc(normalizedScreenName);
  const doc = await agentRef.get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data() || {};
  const { tunnelUrl, lastSeenAt, registeredAt } = data;

  if (!tunnelUrl) {
    return null;
  }

  const now = Timestamp.now();
  const fallbackSeen = lastSeenAt || registeredAt;

  if (!fallbackSeen) {
    return null;
  }

  const expiryCutoff = new Timestamp(
    now.seconds - AGENT_URL_TTL_MINUTES * 60,
    now.nanoseconds,
  );

  if (fallbackSeen < expiryCutoff) {
    console.log(
      `[Hub] Agent for "${normalizedScreenName}" has expired. Deleting.`,
    );
    await agentRef.delete();
    return null;
  }

  const secondsSinceLastSeen = now.seconds - fallbackSeen.seconds;

  if (secondsSinceLastSeen >= 30) {
    try {
      await agentRef.update({ lastSeenAt: now });
    } catch (updateError) {
      console.warn(
        `[Hub] Failed to refresh lastSeenAt for "${normalizedScreenName}":`,
        updateError,
      );
    }
  }

  return { tunnelUrl };
}

app.post("/api/register-agent", async (req, res) => {
  const {
    screenName,
    tunnelUrl,
    requiresNanobananaKey = false,
    hasLocalNanobananaKey = false,
  } = req.body;
  const normalizedScreenName = normalizeScreenName(screenName);

  if (!normalizedScreenName || !tunnelUrl) {
    return res
      .status(400)
      .json({ error: "screenName and tunnelUrl are required." });
  }

  try {
    console.log(
      `[Hub] Registering agent for "${screenName}" (normalized: "${normalizedScreenName}") at ${tunnelUrl}`,
    );
    const agentRef = firestore.collection("agents").doc(normalizedScreenName);
    const now = Timestamp.now();
    const needsDefaultNanobananaKey =
      Boolean(requiresNanobananaKey) && !hasLocalNanobananaKey;
    await agentRef.set({
      tunnelUrl,
      registeredAt: now,
      lastSeenAt: now,
      screenNameOriginal: screenName,
      requiresNanobananaKey: Boolean(requiresNanobananaKey),
      hasLocalNanobananaKey: Boolean(hasLocalNanobananaKey),
      usesHubNanobananaKey: needsDefaultNanobananaKey,
    });

    if (needsDefaultNanobananaKey) {
      try {
        await deliverDefaultNanobananaKey(tunnelUrl);
      } catch (deliveryError) {
        console.error(
          `[Hub] Failed to deliver default nanobanana key to "${normalizedScreenName}":`,
          deliveryError,
        );
        try {
          await agentRef.delete();
        } catch (cleanupError) {
          console.warn(
            `[Hub] Failed to clean up agent record for "${normalizedScreenName}" after secret delivery error:`,
            cleanupError,
          );
        }
        return res.status(500).json({
          error: "Failed to deliver default nanobanana key from Hub.",
        });
      }
    }

    res.status(200).json({ message: "Agent registered successfully." });
  } catch (error) {
    console.error(
      `[Hub] Error registering agent for "${normalizedScreenName}":`,
      error,
    );
    res.status(500).json({ error: "Failed to register agent." });
  }
});

app.post("/api/unregister-agent", async (req, res) => {
  const { screenName } = req.body;
  const normalizedScreenName = normalizeScreenName(screenName);

  if (!normalizedScreenName) {
    return res.status(400).json({ error: "screenName is required." });
  }

  try {
    console.log(
      `[Hub] Unregistering agent for "${normalizedScreenName}" (original: "${screenName}")`,
    );
    const agentRef = firestore.collection("agents").doc(normalizedScreenName);
    await agentRef.delete();
    res.status(200).json({ message: "Agent unregistered successfully." });
  } catch (error) {
    console.error(
      `[Hub] Error unregistering agent for "${normalizedScreenName}":`,
      error,
    );
    res.status(500).json({ error: "Failed to unregister agent." });
  }
});

app.get("/api/get-agent-url", async (req, res) => {
  const { screenName } = req.query;
  const normalizedScreenName = normalizeScreenName(screenName);

  if (!normalizedScreenName) {
    return res
      .status(400)
      .json({ error: "screenName query parameter is required." });
  }

  try {
    const agent = await getActiveAgent(normalizedScreenName);

    if (!agent) {
      console.log(
        `[Hub] No active agent found for screen name "${normalizedScreenName}"`,
      );
      return res
        .status(404)
        .json({ error: "No active agent found for this screen name." });
    }

    console.log(
      `[Hub] Found agent for "${normalizedScreenName}" at ${agent.tunnelUrl}`,
    );
    res.status(200).json({ tunnelUrl: agent.tunnelUrl });
  } catch (error) {
    console.error(
      `[Hub] Error getting agent URL for "${normalizedScreenName}":`,
      error,
    );
    res.status(500).json({ error: "Failed to retrieve agent URL." });
  }
});

app.get("/api/background/latest", async (req, res) => {
  const { screenName, since, wait } = req.query;
  const normalizedScreenName = normalizeScreenName(screenName);

  if (!normalizedScreenName) {
    return res
      .status(400)
      .json({ error: "screenName query parameter is required." });
  }

  try {
    const agent = await getActiveAgent(normalizedScreenName);

    if (!agent) {
      console.log(
        `[Hub] No active agent found for background request from "${normalizedScreenName}"`,
      );
      return res
        .status(404)
        .json({ error: "No active agent found for this screen name." });
    }

    const tunnelBase = agent.tunnelUrl.replace(/\/$/, "");
    const requestUrl = `${tunnelBase}/background/latest`;

    const params = {};
    if (typeof since !== "undefined") {
      params.since = since;
    }
    if (typeof wait !== "undefined") {
      params.wait = wait;
    }

    console.log(
      `[Hub] Proxying background request for "${normalizedScreenName}" → ${requestUrl}`,
    );

    const response = await fetchBackgroundWithRetry({
      url: requestUrl,
      params,
      normalizedScreenName,
    });

    res.status(response.status);

    const versionHeader = response.headers["x-background-version"];
    if (versionHeader) {
      res.set("x-background-version", versionHeader);
    }

    const contentType = response.headers["content-type"];
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    res.set("Cache-Control", "no-store");

    if (response.status === 204 || !response.data) {
      return res.send();
    }

    return res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(
      `[Hub] Error fetching background for "${normalizedScreenName}":`,
      error.response ? error.response.statusText : error.message,
    );

    if (error.response) {
      const { status, data } = error.response;
      const payload =
        data && typeof data === "object"
          ? data
          : { error: "Failed to retrieve background image." };
      return res.status(status).json(payload);
    }

    return res
      .status(502)
      .json({ error: "Unable to contact agent tunnel for background." });
  }
});

async function fetchBackgroundWithRetry({ url, params, normalizedScreenName }) {
  let attempt = 0;
  let lastError;

  while (attempt < BACKGROUND_PROXY_RETRIES) {
    try {
      return await axios.get(url, {
        params,
        responseType: "arraybuffer",
        validateStatus: () => true,
        timeout: BACKGROUND_PROXY_TIMEOUT_MS,
        headers: {
          Accept: "image/*,application/json;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error) {
      lastError = error;

      if (error.response) {
        return error.response;
      }

      const delay = Math.min(1_000, 250 * (attempt + 1));
      console.warn(
        `[Hub] Attempt ${attempt + 1} to fetch background for "${normalizedScreenName}" failed: ${error.code || error.message}. Retrying in ${delay}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    attempt += 1;
  }

  throw lastError ?? new Error("Background fetch failed with unknown error.");
}

// --- Zoom OAuth Flow ---
const redirectUri = `https://slowlyunhinged-hub-54127830651.us-central1.run.app/auth/zoom/callback`;

app.get("/auth/zoom", (req, res) => {
  const authorizationUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${zoomClientId}&redirect_uri=${redirectUri}`;
  res.redirect(authorizationUrl);
});

app.get("/auth/zoom/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Error: Authorization code is missing.");
  }

  try {
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", redirectUri);

    const authHeader = `Basic ${Buffer.from(
      `${zoomClientId}:${zoomClientSecret}`,
    ).toString("base64")}`;

    console.log(
      "[Hub-Debug] Attempting to get access token with data:",
      params.toString(),
    );
    console.log(
      `[Hub-Debug] Authorization Header (first 10 chars): ${authHeader.substring(
        0,
        10,
      )}...`,
    );

    const tokenResponse = await axios.post(
      "https://zoom.us/oauth/token",
      params,
      {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const accessToken = tokenResponse.data.access_token;

    const userProfileResponse = await axios.get(
      "https://api.zoom.us/v2/users/me",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const userEmail = userProfileResponse.data.email;

    console.log(`[Hub] OAuth successful for user: ${userEmail}`);
    res.send(`
      <script>
        localStorage.setItem('userEmail', '${userEmail}');
        window.location.href = '/zoom_app.html';
      </script>
    `);
  } catch (error) {
    console.error(
      "[Hub] Error in OAuth callback:",
      error.response ? error.response.data : error.message,
    );
    if (error.config) {
      const redactedConfig = { ...error.config };
      if (redactedConfig.headers && redactedConfig.headers.Authorization) {
        redactedConfig.headers.Authorization = `${redactedConfig.headers.Authorization.substring(
          0,
          10,
        )}...REDACTED`;
      }
      console.error("[Hub-Debug] Failed Axios Request Config:", redactedConfig);
    }
    res.status(500).send("An error occurred during authentication.");
  }
});

// --- Frontend Serving ---

app.get("/", (req, res) => {
  const zoomAppPath = path.resolve(__dirname, "zoom_app.html");
  res.sendFile(zoomAppPath, (err) => {
    if (err) {
      console.error(
        "[Hub] Failed to serve zoom_app.html at root path:",
        err.message,
      );
      res
        .status(500)
        .send("Zoom App frontend is unavailable. Please try again later.");
    }
  });
});

// --- Error Handling ---
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

// --- Server Start ---
if (!zoomClientId || !zoomClientSecret) {
  console.error(
    "FATAL: ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET environment variables are not set.",
  );
  process.exit(1);
}

app.listen(port, () => {
  console.log(`[Hub] GooseHack Central Hub listening on port ${port}`);
  console.log(
    `[Hub] To start the OAuth flow, visit: /auth/zoom (relative to the service URL)`,
  );
  console.log(`[Hub] Your OAuth Redirect URI is: ${redirectUri}`);
});
