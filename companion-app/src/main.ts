import { invoke } from "@tauri-apps/api/core";
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

type WaveformOptions = {
  color: string;
  background: string;
};

type BackgroundImageResult = {
  dataUrl: string;
};

type BackgroundPromptDecision =
  | {
      status: "generate";
      prompt: string;
      rawText: string;
    }
  | {
      status: "skip";
      reason: string;
      rawText: string;
    };

let startBtnEl: HTMLButtonElement | null;
let stopBtnEl: HTMLButtonElement | null;
let transcribeBtnEl: HTMLButtonElement | null;
let statusMsgEl: HTMLElement | null;
let videoEl: HTMLVideoElement | null;
let cameraStatusEl: HTMLElement | null;
let micCanvasEl: HTMLCanvasElement | null;
let micStatusEl: HTMLElement | null;
let backgroundPromptEl: HTMLElement | null;
let backgroundImageEl: HTMLImageElement | null;
let backgroundImageStatusEl: HTMLElement | null;
let lastBackgroundPrompt: string | null = null;
let preflightScreenEl: HTMLElement | null;
let appContentEl: HTMLElement | null;
let preflightStatusEl: HTMLElement | null;
let preflightPermissionsBtnEl: HTMLButtonElement | null;
let preflightRetryBtnEl: HTMLButtonElement | null;
let screenNamePreviewEl: HTMLElement | null;
let wheelsContainerEl: HTMLElement | null;
let gestureStatusEl: HTMLElement | null;
let activeWheelStatusEl: HTMLElement | null;
let logContainerEl: HTMLElement | null;

let cameraStream: MediaStream | null = null;

let micAnalyser: AnalyserNode | null = null;

let micAnimationId: number | null = null;

let micAudioContext: AudioContext | null = null;
let permissionsGranted = false;
let isTranscriptionInProgress = false;
let isBackgroundImageInProgress = false;

const MEDIAPIPE_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const HAND_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const GESTURE_HISTORY_WINDOW_MS = 350;
const GESTURE_IDLE_STATUS_DELAY_MS = 1000;
const SWIPE_MIN_DISPLACEMENT = 0.12;
const WHEEL_ADJUST_COOLDOWN_MS = 400;
const WHEEL_SWITCH_COOLDOWN_MS = 400;
const CLAP_COOLDOWN_MS = 2000;
const CLAP_DISTANCE_THRESHOLD = 0.12;
const CLAP_DELTA_THRESHOLD = -0.06;
const CLAP_MAX_INTERVAL_MS = 250;
const FINGER_EXTENSION_MIN_DELTA = 0.015;
const PALM_OPEN_MIN_AVG_TIP_DISTANCE = 0.18;
const WHEEL_STATE_SAVE_DELAY_MS = 400;
const MAX_LOG_ENTRIES = 200;
const LOG_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const TRANSCRIPTION_SAMPLE_DURATION_MS = 12_000;
const TRANSCRIPTION_SAMPLE_RATE = 16_000;
const TRANSCRIPTION_PROMPT =
  "Transcribe the provided audio sample verbatim, including filler words when they are audible.";
const TRANSCRIPTION_ENDPOINT =
  "http://localhost:12434/engines/llama.cpp/v1/chat/completions";
const DMR_BASE_URL = "http://localhost:12434";
let TRANSCRIPTION_MODEL = "";
let BACKGROUND_PROMPT_MODEL = "";

type Settings = {
  modelTranscription?: string;
  modelPrompt?: string;
};

async function loadSettings() {
  try {
    const settings = await invoke<Settings>("get_settings");
    if (settings.modelTranscription) {
      TRANSCRIPTION_MODEL = settings.modelTranscription;
    }
    if (settings.modelPrompt) {
      BACKGROUND_PROMPT_MODEL = settings.modelPrompt;
    }
  } catch (error) {
    console.error("Failed to load settings", error);
  }
}

const AUTO_TRANSCRIPTION_RETRY_DELAY_MS = 1_000;
const AUTO_TRANSCRIPTION_FALLBACK_DELAY_MS = 1_000;
const AUTO_TRANSCRIPTION_POST_IMAGE_DELAY_MS = 300;

const BACKGROUND_PROMPT_ENDPOINT =
  "http://localhost:12434/engines/llama.cpp/v1/chat/completions";
const BACKGROUND_PROMPT_SYSTEM_PROMPT =
  "You are a helpful assistant that writes vivid prompts for image generation models.";
const BACKGROUND_PROMPT_INSTRUCTIONS = [
  "You are a helpful assistant that writes vivid prompts for image generation models.",
  "Given a transcript and potentially a previous background prompt, decide whether the transcript is rich enough to inspire a fresh virtual background.",
  "If the transcript is descriptive, respond with JSON exactly like {\"status\":\"generate\",\"prompt\":\"<vivid 1-2 sentence background prompt>\"}.",
  "If the transcript lacks descriptive detail but conveys a clear emotion (e.g., happiness, excitement, frustration), analyze the emotion. Then, modify the previous background prompt to reflect this emotion. Respond with JSON exactly like {\"status\":\"generate\",\"prompt\":\"<vivid 1-2 sentence background prompt reflecting the emotion>\"}.",
  "If the transcript is brief, contains mostly silence or filler sounds, and lacks both descriptive detail and clear emotion, respond with JSON exactly like {\\\"status\\\":\\\"skip\\\",\\\"reason\\\":\\\"brief explanation\\\"}.",
  "If a previous prompt is provided, the new prompt should aim to modify the scene rather than starting over. For example, if the old prompt was \"a tranquil beach at sunset\" and the transcript mentions a boat, a good new prompt would be \"a tranquil beach at sunset with a small sailboat on the water\". When modifying for emotion, you could change the weather or time of day, for example, a happy emotion could be a bright sunny day, and a sad emotion could be a rainy day.",
  "Do not include personally identifiable information such as names or emails.",
  "Return a single-line JSON object with double-quoted keys and values. Do not include any text before or after the JSON.",
  "",
  "Transcript:",
].join("\n");

type WheelPersistedState = {
  positions: number[];
  activeIndex: number;
};

const MIC_WAVEFORM_STYLE: WaveformOptions = {
  color: "#4caf50",
  background: "#040404",
};
const CHARSET = [
  " ",
  "@",
  ".",
  "-", // dash support for screen-name registration
  ...Array.from({ length: 26 }, (_, i) =>
    String.fromCharCode("a".charCodeAt(0) + i),
  ),
  ...Array.from({ length: 10 }, (_, i) => i.toString()),
];
const WHEEL_COUNT = 20;
const WHEEL_REPEAT = 3;
const WHEEL_ITEM_HEIGHT = 32;
let activeWheelIndex = 0;
let currentGestureStatus = "Gestures inactive.";
let lastGestureStatusTime = 0;
const wheelPositions = Array.from({ length: WHEEL_COUNT }, () => 0);
let wheelTracks: HTMLElement[] = [];
let wheelElements: HTMLElement[] = [];
let wheelStateSaveTimeout: number | null = null;
let wheelStateLoaded = false;
let suppressWheelStateSave = false;
let autoTranscriptionEnabled = false;
let autoTranscriptionTimer: number | null = null;
let autoAwaitingBackgroundImage = false;
let wheelsLocked = false;
let gesturesLocked = false;

const PREFLIGHT_KEYS = ["docker", "dmr", "models", "permissions"] as const;
type PreflightKey = (typeof PREFLIGHT_KEYS)[number];
type PreflightState = "pending" | "running" | "waiting" | "success" | "error";

const PREFLIGHT_STATUS_LABELS: Record<PreflightState, string> = {
  pending: "Pending…",
  running: "Checking…",
  waiting: "In progress…",
  success: "Ready",
  error: "Needs attention",
};

type PreflightElements = {
  row: HTMLElement | null;
  status: HTMLElement | null;
  message: HTMLElement | null;
};

const preflightElements: Record<PreflightKey, PreflightElements> = {
  docker: { row: null, status: null, message: null },
  dmr: { row: null, status: null, message: null },
  models: { row: null, status: null, message: null },
  permissions: { row: null, status: null, message: null },
};

let preflightState: Record<PreflightKey, PreflightState> = {
  docker: "pending",
  dmr: "pending",
  models: "pending",
  permissions: "pending",
};
let preflightInProgress = false;
let preflightCompleted = false;

type HandLabel = "Left" | "Right";
type HandSample = {
  x: number;
  y: number;
  time: number;
};
type HandObservation = {
  label: HandLabel;
  center: { x: number; y: number };
};
type NormalizedLandmark = {
  x: number;
  y: number;
  z: number;
};

let handLandmarker: HandLandmarker | null = null;
let handLandmarkerInitPromise: Promise<void> | null = null;
let gestureLoopId: number | null = null;
let lastGestureVideoTimeMs = -1;
const handHistories: Record<HandLabel, HandSample[]> = {
  Left: [],
  Right: [],
};
let lastTwoHandDistance: { distance: number; time: number } | null = null;
const gestureState = {
  lastWheelAdjustTime: 0,
  lastWheelSwitchTime: 0,
  lastClapTime: 0,
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name: string }).name);
  }
  return "Unknown error";
}

function setTextContent(element: HTMLElement | null, text: string) {
  if (element) {
    element.textContent = text;
  }
}

function setButtonDisabled(
  button: HTMLButtonElement | null,
  disabled: boolean,
) {
  if (button) {
    button.disabled = disabled;
  }
}

function logEvent(message: string, level: "info" | "error" = "info") {
  const timestamp = new Date().toLocaleTimeString([], LOG_TIME_OPTIONS);
  const formatted = `[${timestamp}] ${message}`;

  if (level === "error") {
    console.error(formatted);
  } else {
    console.log(formatted);
  }

  if (!logContainerEl) {
    return;
  }

  const entry = document.createElement("div");
  entry.className = "log-entry";
  if (level === "error") {
    entry.classList.add("log-entry-error");
  }
  entry.textContent = formatted;

  logContainerEl.prepend(entry);
  const excess = logContainerEl.children.length - MAX_LOG_ENTRIES;
  for (let i = 0; i < excess; i += 1) {
    const last = logContainerEl.lastElementChild;
    if (last) {
      logContainerEl.removeChild(last);
    }
  }
  logContainerEl.scrollTop = 0;
}

function setWheelsLocked(locked: boolean) {
  const changed = wheelsLocked !== locked;
  wheelsLocked = locked;
  wheelElements.forEach((wheel) => {
    wheel.classList.toggle("wheel-locked", locked);
    wheel.style.pointerEvents = locked ? "none" : "";
  });
  if (wheelsContainerEl) {
    wheelsContainerEl.classList.toggle("wheel-locked", locked);
  }
  updateActiveWheelStatus();
  if (changed) {
    logEvent(locked ? "[Wheels] Wheel controls locked." : "[Wheels] Wheel controls unlocked.");
  }
}

function setGesturesLocked(locked: boolean) {
  if (gesturesLocked === locked) {
    if (locked) {
      setGestureStatus("Gestures locked while agent active.");
    }
    return;
  }
  const wasLocked = gesturesLocked;
  gesturesLocked = locked;
  if (locked) {
    stopGestureRecognition();
    setGestureStatus("Gestures locked while agent active.");
    logEvent("[Gestures] Gesture recognition locked.");
  } else if (wasLocked) {
    if (permissionsGranted) {
      setGestureStatus("Gestures ready.");
      void startGestureRecognition();
    } else {
      setGestureStatus("Gestures inactive.");
    }
    logEvent("[Gestures] Gesture recognition unlocked.");
  }
}

function setPreflightState(
  key: PreflightKey,
  state: PreflightState,
  message?: string,
  statusOverride?: string,
) {
  preflightState[key] = state;
  const elements = preflightElements[key];
  if (elements.row) {
    elements.row.dataset.state = state;
  }
  if (elements.status) {
    elements.status.textContent =
      statusOverride ?? PREFLIGHT_STATUS_LABELS[state];
  }
  if (elements.message && message !== undefined) {
    elements.message.textContent = message;
  }
}

function setPreflightStatusText(text: string) {
  if (preflightStatusEl) {
    preflightStatusEl.textContent = text;
  }
}

function resetPreflightState() {
  preflightState = {
    docker: "pending",
    dmr: "pending",
    models: "pending",
    permissions: "pending",
  };
  PREFLIGHT_KEYS.forEach((key) => {
    setPreflightState(key, "pending", "");
  });
  if (preflightPermissionsBtnEl) {
    preflightPermissionsBtnEl.disabled = true;
  }
  if (preflightRetryBtnEl) {
    preflightRetryBtnEl.classList.add("hidden");
  }
  setPreflightStatusText("");
}

function showPreflightFailure(message: string) {
  setPreflightStatusText(message);
  if (preflightRetryBtnEl) {
    preflightRetryBtnEl.classList.remove("hidden");
  }
  preflightInProgress = false;
}

async function hasGrantedMediaPermissions(): Promise<boolean> {
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some(
        (device) =>
          device.kind === "videoinput" && typeof device.label === "string" && device.label.trim().length > 0,
      );
      const hasMic = devices.some(
        (device) =>
          device.kind === "audioinput" && typeof device.label === "string" && device.label.trim().length > 0,
      );
      if (hasCamera && hasMic) {
        return true;
      }
    }
  } catch {
    // Fall back to permissions API below.
  }

  try {
    if ("permissions" in navigator && navigator.permissions?.query) {
      const cameraPermission = await navigator.permissions.query({
        name: "camera" as PermissionName,
      });
      const micPermission = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      return cameraPermission.state === "granted" && micPermission.state === "granted";
    }
  } catch {
    // Ignore errors; assume permissions not granted.
  }

  return false;
}

async function runPreflightChecks() {
  if (preflightCompleted || preflightInProgress) {
    return;
  }

  preflightInProgress = true;
  resetPreflightState();
  setPreflightStatusText("Checking Docker Desktop…");

  setPreflightState(
    "docker",
    "running",
    "Verifying Docker Desktop can pull and start containers…",
  );
  logEvent("[Preflight] Checking Docker Desktop…");
  try {
    await invoke("check_docker_access");
    setPreflightState(
      "docker",
      "success",
      "Docker Desktop is running and a test container completed successfully.",
      "Ready",
    );
    logEvent("[Preflight] Docker Desktop check passed.");
  } catch (error) {
    const message = formatError(error);
    setPreflightState(
      "docker",
      "error",
      `Unable to start a cloudflared test container. Make sure Docker Desktop is running and you are signed in. Details: ${message}`,
      "Docker not available",
    );
    logEvent(
      `[Preflight] Docker Desktop check failed: ${message}`,
      "error",
    );
    showPreflightFailure(
      "Start Docker Desktop (and ensure it is running) before continuing.",
    );
    return;
  }

  setPreflightState(
    "dmr",
    "running",
    "Contacting Docker Model Runner at http://localhost:12434…",
  );
  setPreflightStatusText("Checking Docker Model Runner on http://localhost:12434…");
  logEvent("[Preflight] Checking Docker Model Runner…");
  try {
    const modelsEndpoint = `${DMR_BASE_URL}/engines/llama.cpp/v1/models`;
    const response = await fetch(modelsEndpoint);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bodyText = await response.text();
    let summary = bodyText.trim();
    try {
      const parsed = JSON.parse(bodyText) as { data?: Array<{ id?: string }> };
      if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        const ids = parsed.data
          .map((entry) => (entry && typeof entry.id === "string" ? entry.id : "unknown"))
          .slice(0, 3)
          .join(", ");
        summary = `Models available: ${ids}${
          parsed.data.length > 3 ? ` (+${parsed.data.length - 3} more)` : ""
        }`;
      } else if (parsed && typeof parsed === "object") {
        summary = "Docker Model Runner responded with JSON.";
      }
    } catch {
      // Ignore parse failure; fall back to raw text snippet below.
    }
    const snippet = summary.length > 160 ? `${summary.slice(0, 160)}…` : summary || "OK";
    setPreflightState(
      "dmr",
      "success",
      `Docker Model Runner responded: ${snippet}`,
      "Ready",
    );
    logEvent("[Preflight] Docker Model Runner responded successfully.");
  } catch (error) {
    const message = formatError(error);
    setPreflightState(
      "dmr",
      "error",
      `Could not reach Docker Model Runner at ${DMR_BASE_URL}/engines/llama.cpp/v1/models. Enable Docker Model Runner following https://docs.docker.com/ai/model-runner/get-started/#enable-docker-model-runner. Details: ${message}`,
      "DMR offline",
    );
    logEvent(
      `[Preflight] Docker Model Runner check failed: ${message}`,
      "error",
    );
    showPreflightFailure(
      "Enable Docker Model Runner and wait for http://localhost:12434/engines/llama.cpp/v1/models to respond (see docs).",
    );
    return;
  }

  setPreflightState(
    "models",
    "waiting",
    "Ensuring required speech and prompt models are downloaded. The first run can take a few minutes.",
    "Ensuring models…",
  );
  setPreflightStatusText(
    "Ensuring Docker Model Runner has downloaded the required models. This may take several minutes the first time.",
  );
  logEvent("[Preflight] Ensuring required models are available…");
  try {
    await invoke("ensure_models_ready");
    setPreflightState(
      "models",
      "success",
      "All required Docker Model Runner models are ready.",
      "Ready",
    );
    logEvent("[Preflight] Required models confirmed.");
  } catch (error) {
    const message = formatError(error);
    setPreflightState(
      "models",
      "error",
      `Docker Model Runner is still downloading models or returned an error. Leave it running and retry once downloads finish. Details: ${message}`,
      "Downloading models",
    );
    logEvent(
      `[Preflight] Model availability check failed: ${message}`,
      "error",
    );
    showPreflightFailure(
      "Waiting for Docker Model Runner to finish downloading models. Leave it running and retry.",
    );
    return;
  }

  const preGranted = await hasGrantedMediaPermissions();
  if (preGranted) {
    logEvent(
      "[Preflight] Camera and microphone permissions already granted. Initialising automatically.",
    );
  } else {
    logEvent("[Preflight] Requesting camera and microphone access automatically.");
  }

  const autoSuccess = await ensurePermissions();
  if (autoSuccess) {
    preflightInProgress = false;
    completePreflight();
    return;
  }

  logEvent(
    "[Preflight] Automatic permission initialisation failed; waiting for manual confirmation.",
    "error",
  );
  setPreflightState(
    "permissions",
    "waiting",
    "Click the button below to grant camera and microphone access. If you don’t see a prompt, review your OS privacy settings.",
    "Action required",
  );
  setPreflightStatusText("Grant camera and microphone access to continue.");
  if (preflightPermissionsBtnEl) {
    preflightPermissionsBtnEl.disabled = false;
    preflightPermissionsBtnEl.focus();
  }
  if (preflightRetryBtnEl) {
    preflightRetryBtnEl.classList.add("hidden");
  }
  preflightInProgress = false;
}

async function handlePreflightPermissions() {
  if (preflightCompleted) {
    return;
  }

  const success = await ensurePermissions();
  if (success) {
    completePreflight();
  }
}

function clearAutoTranscriptionTimer() {
  if (autoTranscriptionTimer !== null) {
    window.clearTimeout(autoTranscriptionTimer);
    autoTranscriptionTimer = null;
  }
}

function scheduleAutoTranscription(delayMs: number, reason?: string) {
  if (!autoTranscriptionEnabled) {
    return;
  }

  const clampedDelay = Math.max(0, delayMs);
  clearAutoTranscriptionTimer();

  const context = reason ? ` (${reason})` : "";
  logEvent(
    `[Auto] Scheduling next transcription in ${clampedDelay} ms${context}.`,
  );

  autoTranscriptionTimer = window.setTimeout(() => {
    autoTranscriptionTimer = null;
    if (!autoTranscriptionEnabled) {
      logEvent("[Auto] Skipping scheduled transcription; loop disabled.");
      return;
    }
    void triggerTranscriptionCapture();
  }, clampedDelay);
}

function startAutoTranscriptionLoop(initialDelayMs = 0) {
  if (!autoTranscriptionEnabled) {
    autoTranscriptionEnabled = true;
    autoAwaitingBackgroundImage = false;
    logEvent("[Auto] Automatic transcription loop enabled.");
  }

  scheduleAutoTranscription(initialDelayMs, "loop start");
}

function stopAutoTranscriptionLoop() {
  if (!autoTranscriptionEnabled) {
    return;
  }

  autoTranscriptionEnabled = false;
  autoAwaitingBackgroundImage = false;
  clearAutoTranscriptionTimer();
  logEvent("[Auto] Automatic transcription loop disabled.");
}

function toggleAppVisibility(showApp: boolean) {
  if (preflightScreenEl) {
    preflightScreenEl.classList.toggle("hidden", showApp);
  }
  if (appContentEl) {
    appContentEl.classList.toggle("hidden", !showApp);
  }
}

function setGestureStatus(message: string, timestamp = performance.now()) {
  if (message !== currentGestureStatus) {
    currentGestureStatus = message;
    if (gestureStatusEl) {
      gestureStatusEl.textContent = message;
    }
  }
  lastGestureStatusTime = timestamp;
}

function getCharForPosition(position: number) {
  return CHARSET[((position % CHARSET.length) + CHARSET.length) % CHARSET.length];
}

function getScreenNameFromWheels() {
  const raw = wheelPositions.map(getCharForPosition).join("");
  const trimmed = raw.trim();
  return trimmed.replace(/\s+/g, " ");
}

function updateScreenNamePreview() {
  if (!screenNamePreviewEl) {
    return;
  }
  const value = getScreenNameFromWheels();
  if (value) {
    setTextContent(screenNamePreviewEl, `Screen name: ${value}`);
  } else {
    setTextContent(screenNamePreviewEl, "Screen name: (blank)");
  }
}

function updateActiveWheelStatus() {
  if (activeWheelStatusEl) {
    const baseStatus = `Active wheel: ${activeWheelIndex + 1}`;
    activeWheelStatusEl.textContent = wheelsLocked
      ? `${baseStatus} (locked)`
      : baseStatus;
  }
}

function updateActiveWheelHighlight() {
  wheelElements.forEach((wheel, index) => {
    wheel.classList.toggle("wheel-active", index === activeWheelIndex);
  });
}

function setActiveWheel(index: number) {
  activeWheelIndex = ((index % WHEEL_COUNT) + WHEEL_COUNT) % WHEEL_COUNT;
  updateActiveWheelHighlight();
  updateActiveWheelStatus();
  scheduleWheelStateSave();
}

function adjustWheel(index: number, delta: number) {
  wheelPositions[index] =
    (wheelPositions[index] + delta + CHARSET.length) % CHARSET.length;
  updateWheelTransform(index);
  if (index === activeWheelIndex) {
    updateActiveWheelStatus();
  }
  updateScreenNamePreview();
  scheduleWheelStateSave();
}

function updateWheelTransform(index: number) {
  const track = wheelTracks[index];
  if (!track) {
    return;
  }
  const baseIndex = CHARSET.length + wheelPositions[index];
  const translate = -baseIndex * WHEEL_ITEM_HEIGHT;
  track.style.transform = `translateY(${translate}px)`;

  const items = track.querySelectorAll<HTMLElement>(".wheel-item");
  items.forEach((item, itemIndex) => {
    item.classList.toggle("wheel-item-active", itemIndex === baseIndex);
  });
}

function buildWheel(index: number) {
  const wheel = document.createElement("div");
  wheel.className = "wheel";
  wheel.dataset.index = String(index);

  const viewport = document.createElement("div");
  viewport.className = "wheel-viewport";

  const track = document.createElement("div");
  track.className = "wheel-track";

  const totalItems = CHARSET.length * WHEEL_REPEAT;
  for (let i = 0; i < totalItems; i += 1) {
    const item = document.createElement("div");
    item.className = "wheel-item";
    item.textContent = CHARSET[i % CHARSET.length];
    track.appendChild(item);
  }

  viewport.appendChild(track);
  wheel.appendChild(viewport);

  const overlay = document.createElement("div");
  overlay.className = "wheel-overlay";
  wheel.appendChild(overlay);

  if (wheelsLocked) {
    wheel.classList.add("wheel-locked");
    wheel.style.pointerEvents = "none";
  }

  wheelTracks[index] = track;
  wheelElements[index] = wheel;
  updateWheelTransform(index);

  wheel.addEventListener("wheel", (event) => {
    if (wheelsLocked) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    setActiveWheel(index);
    adjustWheel(index, direction);
  });

  wheel.addEventListener("click", (event) => {
    if (wheelsLocked) {
      return;
    }
    const rect = wheel.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const direction = event.clientY < midpoint ? -1 : 1;
    setActiveWheel(index);
    adjustWheel(index, direction);
  });

  return wheel;
}

function initializeWheels() {
  if (!wheelsContainerEl) {
    return;
  }
  wheelTracks = [];
  wheelElements = [];
  wheelsContainerEl.innerHTML = "";
  for (let i = 0; i < WHEEL_COUNT; i += 1) {
    const wheel = buildWheel(i);
    wheelsContainerEl.appendChild(wheel);
  }
  wheelsContainerEl.classList.toggle("wheel-locked", wheelsLocked);
  updateScreenNamePreview();
  updateActiveWheelHighlight();
  updateActiveWheelStatus();
}

function startWaveform(
  analyser: AnalyserNode,
  canvas: HTMLCanvasElement | null,
  options: WaveformOptions,
  setAnimationId: (id: number | null) => void,
) {
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = options.color;
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i += 1) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    const animationId = window.requestAnimationFrame(draw);
    setAnimationId(animationId);
  };

  draw();
}

function stopWaveform(
  canvas: HTMLCanvasElement | null,
  animationId: number | null,
  setAnimationId: (id: number | null) => void,
) {
  if (animationId !== null) {
    window.cancelAnimationFrame(animationId);
    setAnimationId(null);
  }

  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function chooseRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return undefined;
  }

  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  for (const type of preferredTypes) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return undefined;
}

async function recordMicrophoneSample(durationMs: number): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder API is not available in this environment.");
  }

  if (!cameraStream) {
    throw new Error("Microphone stream is unavailable.");
  }

  const audioTracks = cameraStream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error("Microphone stream has no audio tracks.");
  }

  const sourceTrack = audioTracks[0];
  const clonedTrack = sourceTrack.clone();
  const recordingStream = new MediaStream([clonedTrack]);

  const mimeType = chooseRecordingMimeType();

  let recorder: MediaRecorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream);
  } catch (error) {
    clonedTrack.stop();
    throw error;
  }

  const chunks: Blob[] = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const completion = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      const type =
        chunks[0]?.type || recorder.mimeType || mimeType || "audio/webm";
      resolve(new Blob(chunks, { type }));
    });

    recorder.addEventListener("error", (event) => {
      const recorderEvent = event as Event & { error?: DOMException };
      const recorderError =
        recorderEvent.error ??
        new Error("MediaRecorder emitted an unknown recording error.");
      reject(recorderError);
    });
  });

  recorder.start();
  await delay(durationMs);
  if (recorder.state !== "inactive") {
    recorder.stop();
  }

  const blob = await completion;
  clonedTrack.stop();

  return blob;
}

async function resampleToMono(
  buffer: AudioBuffer,
  targetSampleRate: number,
): Promise<AudioBuffer> {
  if (buffer.numberOfChannels === 1 && buffer.sampleRate === targetSampleRate) {
    return buffer;
  }

  const frameCount = Math.ceil(buffer.duration * targetSampleRate);
  const OfflineAudioCtor =
    window.OfflineAudioContext ??
    (window as Window & {
      webkitOfflineAudioContext?: typeof OfflineAudioContext;
    }).webkitOfflineAudioContext;

  if (!OfflineAudioCtor) {
    throw new Error("OfflineAudioContext is not supported in this environment.");
  }

  const offlineContext = new OfflineAudioCtor(1, frameCount, targetSampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineContext.destination);
  source.start(0);
  return offlineContext.startRendering();
}

function writeUtf8String(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeUtf8String(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeUtf8String(view, 8, "WAVE");
  writeUtf8String(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeUtf8String(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.trunc(intSample), true);
    offset += bytesPerSample;
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

type EncodedAudioPayload = {
  base64: string;
  wavByteLength: number;
  durationSeconds: number;
  sampleRate: number;
};

async function prepareTranscriptionPayload(
  blob: Blob,
): Promise<EncodedAudioPayload> {
  const rawBuffer = await blob.arrayBuffer();
  const decodingContext = new AudioContext();
  const decodedBuffer = await decodingContext.decodeAudioData(
    rawBuffer.slice(0),
  );
  const resampledBuffer = await resampleToMono(
    decodedBuffer,
    TRANSCRIPTION_SAMPLE_RATE,
  );
  await decodingContext.close().catch(() => undefined);

  const samples = resampledBuffer.getChannelData(0);
  const wavBuffer = encodeWav(samples, resampledBuffer.sampleRate);

  return {
    base64: arrayBufferToBase64(wavBuffer),
    wavByteLength: wavBuffer.byteLength,
    durationSeconds: decodedBuffer.duration,
    sampleRate: resampledBuffer.sampleRate,
  };
}

function extractCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const data = payload as {
    choices?: Array<{
      message?: {
        content?:
          | string
          | Array<{ type?: string; text?: string; value?: string }>;
      };
      text?: string;
    }>;
  };

  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    return "";
  }

  const firstChoice = data.choices[0];
  if (typeof firstChoice.text === "string" && firstChoice.text.trim()) {
    return firstChoice.text.trim();
  }

  const message = firstChoice.message;
  if (!message) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content.trim();
  }

  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        if (part.type === "output_text" && typeof part.text === "string") {
          return part.text;
        }
        if (typeof part.text === "string") {
          return part.text;
        }
        if (typeof part.value === "string") {
          return part.value;
        }
        return "";
      })
      .filter((part) => part.trim().length > 0);
    return parts.join(" ").trim();
  }

  return "";
}

function parseBackgroundPromptDecision(
  rawText: string,
): BackgroundPromptDecision {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      status: "skip",
      reason: "Model returned an empty response.",
      rawText: trimmed,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      status?: string;
      prompt?: unknown;
      reason?: unknown;
    };

    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
    if (status === "skip") {
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "Model indicated the transcript was not suitable.";
      return {
        status: "skip",
        reason,
        rawText: trimmed,
      };
    }

    if (status === "generate") {
      const prompt =
        typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
      if (prompt) {
        return {
          status: "generate",
          prompt,
          rawText: trimmed,
        };
      }
      return {
        status: "skip",
        reason: "Model indicated generation but omitted the prompt text.",
        rawText: trimmed,
      };
    }
  } catch {
    // Fall through to treating the text as a prompt.
  }

  return {
    status: "generate",
    prompt: trimmed,
    rawText: trimmed,
  };
}

async function triggerTranscriptionCapture() {
  if (isTranscriptionInProgress) {
    if (autoTranscriptionEnabled) {
      scheduleAutoTranscription(
        AUTO_TRANSCRIPTION_RETRY_DELAY_MS,
        "capture already running",
      );
    }
    return;
  }

  autoAwaitingBackgroundImage = false;
  isTranscriptionInProgress = true;

  if (!(await ensureCapture())) {
    setTextContent(
      micStatusEl,
      "Unable to access microphone. Grant permissions and try again.",
    );
    logEvent(
      "Microphone unavailable. Ensure camera/microphone permissions are granted.",
      "error",
    );
    isTranscriptionInProgress = false;
    if (autoTranscriptionEnabled) {
      scheduleAutoTranscription(
        AUTO_TRANSCRIPTION_RETRY_DELAY_MS,
        "microphone unavailable",
      );
    }
    return;
  }

  if (!transcribeBtnEl) {
    isTranscriptionInProgress = false;
    if (autoTranscriptionEnabled) {
      scheduleAutoTranscription(
        AUTO_TRANSCRIPTION_RETRY_DELAY_MS,
        "transcription control missing",
      );
    }
    return;
  }

  const originalButtonLabel = transcribeBtnEl.textContent ?? "";

  try {
    setTextContent(micStatusEl, "Recording 12-second microphone sample...");
    logEvent("Recording 12-second microphone sample…");
    transcribeBtnEl.disabled = true;
    transcribeBtnEl.classList.add("recording");
    transcribeBtnEl.textContent = "Recording...";

    const recordingStartedAt = performance.now();
    const audioBlob = await recordMicrophoneSample(
      TRANSCRIPTION_SAMPLE_DURATION_MS,
    );
    const recordingDurationMs = performance.now() - recordingStartedAt;
    logEvent(
      `[Transcription] Recorded blob size=${audioBlob.size} bytes in ${recordingDurationMs.toFixed(0)} ms (mimeType=${audioBlob.type}).`,
    );

    transcribeBtnEl.classList.remove("recording");
    transcribeBtnEl.textContent = "Transcribing...";
    logEvent("Uploading audio sample for transcription…");

    setTextContent(micStatusEl, "Transcribing sample...");
    logEvent("[Transcription] Preparing audio payload.");

    const preparationStartedAt = performance.now();
    const encoded = await prepareTranscriptionPayload(audioBlob);
    const preparationDurationMs = performance.now() - preparationStartedAt;
    logEvent(
      `[Transcription] Encoded WAV bytes=${encoded.wavByteLength} (base64 length=${encoded.base64.length}), duration=${encoded.durationSeconds.toFixed(2)}s, sampleRate=${encoded.sampleRate}Hz in ${preparationDurationMs.toFixed(0)} ms.`,
    );

    const payload = {
      model: TRANSCRIPTION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: TRANSCRIPTION_PROMPT,
            },
            {
              type: "input_audio",
              input_audio: {
                data: encoded.base64,
                format: "wav",
              },
            },
          ],
        },
      ],
    };

    const payloadJson = JSON.stringify(payload);
    const payloadBytes = new TextEncoder().encode(payloadJson).length;
    logEvent(
      `[Transcription] Payload JSON bytes=${payloadBytes}, audio payload bytes=${encoded.wavByteLength}.`,
    );

    const requestStartedAt = performance.now();
    const response = await fetch(TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payloadJson,
    });
    const latencyMs = performance.now() - requestStartedAt;
    logEvent(
      `[Transcription] Transcription request completed in ${latencyMs.toFixed(0)} ms with status ${response.status}.`,
    );

    const responseText = await response.text();
    logEvent("[Transcription] Received raw response payload.");

    if (!response.ok) {
      throw new Error(
        `Transcription request failed: HTTP ${response.status}`,
      );
    }

    let transcript = "";
    try {
      const parsed = JSON.parse(responseText) as unknown;
      transcript = extractCompletionText(parsed);
      logEvent("[Transcription] Parsed response JSON.");
      console.log("[Transcription] Parsed response:", parsed);
    } catch (parseError) {
      console.warn(
        "Failed to parse transcription response as JSON.",
        parseError,
      );
      logEvent(
        "[Transcription] Failed to parse response JSON. Check developer console for details.",
        "error",
      );
    }

    if (transcript) {
      logEvent(`[Transcription] Transcript: "${transcript}"`);
      setTextContent(micStatusEl, `Transcript: ${transcript}`);
      await handleVirtualBackgroundPrompt(transcript);
    } else {
      logEvent(
        "[Transcription] Request completed but no transcript text was returned.",
      );
      setTextContent(
        micStatusEl,
        "Transcription succeeded, but no text was returned.",
      );
    }
  } catch (error) {
    console.error("Transcription capture failed.", error);
    logEvent(
      `Transcription capture failed: ${formatError(error)}`,
      "error",
    );
    setTextContent(micStatusEl, `Transcription failed: ${formatError(error)}`);
  } finally {
    if (transcribeBtnEl) {
      transcribeBtnEl.disabled = false;
      transcribeBtnEl.classList.remove("recording");
      transcribeBtnEl.textContent =
        originalButtonLabel || "Record & Transcribe";
    }
    isTranscriptionInProgress = false;
    if (autoTranscriptionEnabled && !autoAwaitingBackgroundImage) {
      scheduleAutoTranscription(
        AUTO_TRANSCRIPTION_FALLBACK_DELAY_MS,
        "post-transcription fallback",
      );
    }
  }
}

async function handleVirtualBackgroundPrompt(transcript: string) {
  if (!transcript.trim()) {
    return;
  }

  logEvent("[Background] Generating virtual background prompt…");
  setTextContent(
    backgroundPromptEl,
    "Generating virtual background prompt…",
  );

  try {
    const decision = await generateVirtualBackgroundPrompt(
      transcript,
      lastBackgroundPrompt,
    );
    if (decision.status === "generate") {
      logEvent(`[Background] Prompt: "${decision.prompt}"`);
      setTextContent(
        backgroundPromptEl,
        `Virtual background prompt: ${decision.prompt}`,
      );
      lastBackgroundPrompt = decision.prompt;
      void requestBackgroundImage(decision.prompt);
    } else {
      logEvent(
        `[Background] Prompt request skipped by model: ${decision.reason}`,
      );
      setTextContent(
        backgroundPromptEl,
        `Virtual background prompt skipped: ${decision.reason}`,
      );
      setTextContent(
        backgroundImageStatusEl,
        "No new background generated.",
      );
    }
  } catch (error) {
    const message = formatError(error);
    logEvent(`[Background] Prompt generation failed: ${message}`, "error");
    setTextContent(
      backgroundPromptEl,
      `Virtual background prompt failed: ${message}`,
    );
    setTextContent(
      backgroundImageStatusEl,
      "Background image unavailable.",
    );
  }
}

async function generateVirtualBackgroundPrompt(
  transcript: string,
  lastPrompt: string | null,
): Promise<BackgroundPromptDecision> {
  const userMessage = lastPrompt
    ? `${BACKGROUND_PROMPT_INSTRUCTIONS}\nPrevious prompt: ${lastPrompt}\n\nTranscript: ${transcript}`
    : `${BACKGROUND_PROMPT_INSTRUCTIONS}\n${transcript}`;
  const payload = {
    model: BACKGROUND_PROMPT_MODEL,
    messages: [
      {
        role: "system",
        content: BACKGROUND_PROMPT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadJson).length;
  logEvent(`[Background] Payload JSON bytes=${payloadBytes}.`);

  const requestStartedAt = performance.now();
  const response = await fetch(BACKGROUND_PROMPT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: payloadJson,
  });
  const latencyMs = performance.now() - requestStartedAt;
  logEvent(
    `[Background] Prompt request completed in ${latencyMs.toFixed(0)} ms with status ${response.status}.`,
  );

  const responseText = await response.text();
  logEvent("[Background] Received raw prompt response payload.");

  if (!response.ok) {
    throw new Error(
      `Virtual background prompt request failed: HTTP ${response.status}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
    logEvent("[Background] Parsed prompt response JSON.");
  } catch (parseError) {
    logEvent(
      "[Background] Failed to parse prompt response JSON.",
      "error",
    );
    throw new Error(
      `Virtual background prompt response parsing failed: ${formatError(parseError)}`,
    );
  }

  const completion = extractCompletionText(parsed);
  logEvent(`[Background] Model completion text: ${completion}`);

  return parseBackgroundPromptDecision(completion);
}

async function requestBackgroundImage(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return;
  }
  if (isBackgroundImageInProgress) {
    logEvent(
      "[Background] Skipping image request because another generation is in progress.",
    );
    return;
  }

  if (autoTranscriptionEnabled) {
    autoAwaitingBackgroundImage = true;
  }

  isBackgroundImageInProgress = true;
  setTextContent(
    backgroundImageStatusEl,
    "Generating background preview…",
  );
  logEvent("[Background] Requesting nano banana image preview…");

  try {
    const result = await invoke<BackgroundImageResult>(
      "generate_background_image",
      {
        prompt: trimmed,
      },
    );

    if (!result || typeof result.dataUrl !== "string" || !result.dataUrl) {
      throw new Error("Image generation returned an empty payload.");
    }

    if (backgroundImageEl) {
      backgroundImageEl.src = result.dataUrl;
      backgroundImageEl.alt = "Generated virtual background preview.";
    }

    setTextContent(backgroundImageStatusEl, "Background ready.");
    logEvent("[Background] Background image preview updated.");
  } catch (error) {
    const message = formatError(error);
    logEvent(`[Background] Image generation failed: ${message}`, "error");
    setTextContent(
      backgroundImageStatusEl,
      `Background image generation failed: ${message}`,
    );
  } finally {
    isBackgroundImageInProgress = false;
    autoAwaitingBackgroundImage = false;
    if (autoTranscriptionEnabled) {
      scheduleAutoTranscription(
        AUTO_TRANSCRIPTION_POST_IMAGE_DELAY_MS,
        "after background preview",
      );
    }
  }
}

function pushHandSample(label: HandLabel, sample: HandSample) {
  const history = handHistories[label];
  history.push(sample);
  const cutoff = sample.time - GESTURE_HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].time < cutoff) {
    history.shift();
  }
}

function clearHandHistory(label: HandLabel) {
  handHistories[label] = [];
}

function isPalmOpen(landmarks: NormalizedLandmark[]): boolean {
  if (landmarks.length === 0) {
    return false;
  }

  const fingerPairs: Array<[tip: number, pip: number]> = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ];

  let extendedCount = 0;
  fingerPairs.forEach(([tipIndex, pipIndex]) => {
    const tip = landmarks[tipIndex];
    const pip = landmarks[pipIndex];
    if (!tip || !pip) {
      return;
    }
    if (pip.y - tip.y > FINGER_EXTENSION_MIN_DELTA) {
      extendedCount += 1;
    }
  });

  const wrist = landmarks[0];
  if (!wrist) {
    return extendedCount >= 3;
  }

  let avgTipDistance = 0;
  let count = 0;
  fingerPairs.forEach(([tipIndex]) => {
    const tip = landmarks[tipIndex];
    if (!tip) {
      return;
    }
    avgTipDistance += Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
    count += 1;
  });

  if (count > 0) {
    avgTipDistance /= count;
  }

  return extendedCount >= 3 && avgTipDistance >= PALM_OPEN_MIN_AVG_TIP_DISTANCE;
}

function scheduleWheelStateSave() {
  if (!wheelStateLoaded || suppressWheelStateSave) {
    return;
  }
  if (wheelStateSaveTimeout !== null) {
    window.clearTimeout(wheelStateSaveTimeout);
  }
  wheelStateSaveTimeout = window.setTimeout(() => {
    wheelStateSaveTimeout = null;
    void persistWheelState();
  }, WHEEL_STATE_SAVE_DELAY_MS);
}

async function persistWheelState() {
  try {
    await invoke("save_wheel_state", {
      state: {
        positions: [...wheelPositions],
        activeIndex: activeWheelIndex,
      },
    });
  } catch (error) {
    console.error("Failed to persist wheel state", error);
  }
}

function applyPersistedWheelState(state: WheelPersistedState) {
  const { positions, activeIndex } = state;
  if (!Array.isArray(positions) || positions.length !== WHEEL_COUNT) {
    return;
  }

  const resolvedActiveIndex = Number.isFinite(activeIndex)
    ? Math.trunc(activeIndex)
    : activeWheelIndex;

  suppressWheelStateSave = true;
  try {
    positions.forEach((value, index) => {
      const normalized =
        ((Math.round(value) % CHARSET.length) + CHARSET.length) % CHARSET.length;
      wheelPositions[index] = normalized;
      updateWheelTransform(index);
    });
    updateScreenNamePreview();
    setActiveWheel(resolvedActiveIndex);
  } finally {
    suppressWheelStateSave = false;
  }
}

async function loadPersistedWheelState() {
  try {
    const state = await invoke<WheelPersistedState | null>("load_wheel_state");
    if (state) {
      applyPersistedWheelState(state);
    } else {
      setActiveWheel(activeWheelIndex);
    }
  } catch (error) {
    console.error("Failed to load wheel state", error);
  } finally {
    wheelStateLoaded = true;
    scheduleWheelStateSave();
  }
}

function getRecentDisplacement(history: HandSample[]) {
  if (history.length < 2) {
    return null;
  }
  const first = history[0];
  const last = history[history.length - 1];
  const elapsedMs = last.time - first.time;
  if (elapsedMs <= 0) {
    return null;
  }
  return {
    dx: last.x - first.x,
    dy: last.y - first.y,
    elapsedMs,
  };
}

function handleClapDetection(centers: HandObservation[], now: number) {
  const left = centers.find((entry) => entry.label === "Left");
  const right = centers.find((entry) => entry.label === "Right");
  if (!left || !right) {
    lastTwoHandDistance = null;
    return false;
  }

  const distance = Math.hypot(
    left.center.x - right.center.x,
    left.center.y - right.center.y,
  );

  if (lastTwoHandDistance) {
    const deltaDistance = distance - lastTwoHandDistance.distance;
    const elapsed = now - lastTwoHandDistance.time;
    if (
      elapsed <= CLAP_MAX_INTERVAL_MS &&
      deltaDistance <= CLAP_DELTA_THRESHOLD &&
      distance <= CLAP_DISTANCE_THRESHOLD &&
      now - gestureState.lastClapTime > CLAP_COOLDOWN_MS
    ) {
      gestureState.lastClapTime = now;
      lastTwoHandDistance = null;
      void handleClapSubmit();
      setGestureStatus("Clap detected – submitting", now);
      return true;
    }
  }

  lastTwoHandDistance = { distance, time: now };
  return false;
}

async function ensureHandLandmarker(): Promise<boolean> {
  if (handLandmarker) {
    return true;
  }

  if (!handLandmarkerInitPromise) {
    handLandmarkerInitPromise = (async () => {
      const resolver = await FilesetResolver.forVisionTasks(
        MEDIAPIPE_WASM_ROOT,
      );
      handLandmarker = await HandLandmarker.createFromOptions(resolver, {
        baseOptions: {
          modelAssetPath: HAND_LANDMARKER_MODEL_URL,
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
    })();
  }

  try {
    await handLandmarkerInitPromise;
    return Boolean(handLandmarker);
  } catch (error) {
    console.error("Failed to initialize hand landmarker", error);
    setGestureStatus(`Gesture init failed: ${formatError(error)}`);
    handLandmarker = null;
    return false;
  } finally {
    handLandmarkerInitPromise = null;
  }
}

function runGestureLoop() {
  if (!videoEl || !handLandmarker) {
    gestureLoopId = null;
    return;
  }

  if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    gestureLoopId = window.requestAnimationFrame(runGestureLoop);
    return;
  }

  const timestampMs = videoEl.currentTime * 1000;
  if (timestampMs === lastGestureVideoTimeMs) {
    gestureLoopId = window.requestAnimationFrame(runGestureLoop);
    return;
  }
  lastGestureVideoTimeMs = timestampMs;

  const result = handLandmarker.detectForVideo(videoEl, timestampMs);
  processHandLandmarks(result, performance.now());
  gestureLoopId = window.requestAnimationFrame(runGestureLoop);
}

async function startGestureRecognition() {
  if (gestureLoopId !== null) {
    return;
  }

  if (gesturesLocked) {
    setGestureStatus("Gestures locked while agent active.");
    return;
  }

  if (!videoEl) {
    return;
  }

  if (!handLandmarker) {
    setGestureStatus("Initializing gestures…");
  }

  const ready = await ensureHandLandmarker();
  if (!ready || !videoEl || !handLandmarker) {
    return;
  }

  setGestureStatus("Gestures ready.");
  lastGestureVideoTimeMs = -1;
  gestureLoopId = window.requestAnimationFrame(runGestureLoop);
}

function stopGestureRecognition() {
  if (gestureLoopId !== null) {
    window.cancelAnimationFrame(gestureLoopId);
    gestureLoopId = null;
  }
  lastGestureVideoTimeMs = -1;
  handHistories.Left = [];
  handHistories.Right = [];
  lastTwoHandDistance = null;
  if (permissionsGranted) {
    if (gesturesLocked) {
      setGestureStatus("Gestures locked while agent active.");
    } else {
      setGestureStatus("Gestures paused.");
    }
  } else {
    setGestureStatus("Gestures inactive.");
  }
}

function processHandLandmarks(
  result: HandLandmarkerResult | undefined,
  now: number,
) {
  if (gesturesLocked) {
    return;
  }

  if (!result || !result.landmarks || result.landmarks.length === 0) {
    clearHandHistory("Left");
    clearHandHistory("Right");
    lastTwoHandDistance = null;
    if (now - lastGestureStatusTime > GESTURE_IDLE_STATUS_DELAY_MS) {
      setGestureStatus("Hands not detected.", now);
    }
    return;
  }

  const seenLabels: HandLabel[] = [];
  const observations: HandObservation[] = [];
  let closedPalmDetected = false;

  result.landmarks.forEach((landmarks, index) => {
    const handedness = result.handednesses?.[index]?.[0];
    const label =
      handedness?.categoryName === "Left" || handedness?.displayName === "Left"
        ? "Left"
        : handedness?.categoryName === "Right" ||
            handedness?.displayName === "Right"
          ? "Right"
          : null;

    if (!label) {
      return;
    }

    seenLabels.push(label);

    const normalized = landmarks as NormalizedLandmark[];
    if (!isPalmOpen(normalized)) {
      closedPalmDetected = true;
      clearHandHistory(label);
      return;
    }

    const center = normalized.reduce(
      (acc, point) => {
        acc.x += point.x;
        acc.y += point.y;
        return acc;
      },
      { x: 0, y: 0 },
    );
    const count = normalized.length || 1;
    center.x /= count;
    center.y /= count;

    pushHandSample(label, { x: center.x, y: center.y, time: now });
    observations.push({ label, center });
  });

  (["Left", "Right"] as HandLabel[]).forEach((label) => {
    if (!seenLabels.includes(label)) {
      clearHandHistory(label);
    }
  });

  if (observations.length === 0) {
    lastTwoHandDistance = null;
    const statusMessage = closedPalmDetected
      ? "Palms closed – move freely."
      : "Hands not detected.";
    if (now - lastGestureStatusTime > GESTURE_IDLE_STATUS_DELAY_MS) {
      setGestureStatus(statusMessage, now);
    }
    return;
  }

  let gestureHandled = false;

  if (now - gestureState.lastWheelAdjustTime > WHEEL_ADJUST_COOLDOWN_MS) {
    for (const { label } of observations) {
      const displacement = getRecentDisplacement(handHistories[label]);
      if (
        displacement &&
        displacement.elapsedMs <= GESTURE_HISTORY_WINDOW_MS &&
        Math.abs(displacement.dy) >= SWIPE_MIN_DISPLACEMENT &&
        Math.abs(displacement.dy) > Math.abs(displacement.dx)
      ) {
        if (displacement.dy <= -SWIPE_MIN_DISPLACEMENT) {
          adjustWheel(activeWheelIndex, -1);
          setGestureStatus("Wheel up", now);
          gestureState.lastWheelAdjustTime = now;
          gestureHandled = true;
          break;
        }
        if (displacement.dy >= SWIPE_MIN_DISPLACEMENT) {
          adjustWheel(activeWheelIndex, 1);
          setGestureStatus("Wheel down", now);
          gestureState.lastWheelAdjustTime = now;
          gestureHandled = true;
          break;
        }
      }
    }
  }

  if (!gestureHandled && now - gestureState.lastWheelSwitchTime > WHEEL_SWITCH_COOLDOWN_MS) {
    for (const { label } of observations) {
      const displacement = getRecentDisplacement(handHistories[label]);
      if (
        displacement &&
        displacement.elapsedMs <= GESTURE_HISTORY_WINDOW_MS &&
        Math.abs(displacement.dx) >= SWIPE_MIN_DISPLACEMENT &&
        Math.abs(displacement.dx) > Math.abs(displacement.dy)
      ) {
        if (displacement.dx <= -SWIPE_MIN_DISPLACEMENT) {
          setActiveWheel(activeWheelIndex + 1);
          setGestureStatus("Next wheel", now);
          gestureState.lastWheelSwitchTime = now;
          gestureHandled = true;
          break;
        }
        if (displacement.dx >= SWIPE_MIN_DISPLACEMENT) {
          setActiveWheel(activeWheelIndex - 1);
          setGestureStatus("Previous wheel", now);
          gestureState.lastWheelSwitchTime = now;
          gestureHandled = true;
          break;
        }
      }
    }
  }

  const clapTriggered = handleClapDetection(observations, now);
  gestureHandled = gestureHandled || clapTriggered;

  if (!gestureHandled && now - lastGestureStatusTime > GESTURE_IDLE_STATUS_DELAY_MS) {
    setGestureStatus("Hands ready.", now);
  }
}

async function handleClapSubmit() {
  if (!startBtnEl || startBtnEl.disabled || gesturesLocked) {
    return;
  }
  await registerAgent();
}

async function startCameraAndMic(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setTextContent(
      cameraStatusEl,
      "Camera preview not supported in this environment.",
    );
    setTextContent(
      micStatusEl,
      "Microphone monitoring unavailable.",
    );
    logEvent(
      "Browser does not support camera/microphone access APIs.",
      "error",
    );
    return false;
  }

  setTextContent(cameraStatusEl, "Requesting camera and mic permissions...");
  setTextContent(micStatusEl, "Requesting microphone access...");
  logEvent("Requesting access to camera and microphone streams…");

  try {
    await stopCameraAndMic();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    cameraStream = stream;

    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl
        .play()
        .catch(() => {
          /* Autoplay restrictions are expected. */
        });
    }

    setTextContent(cameraStatusEl, "Camera active.");
    logEvent("Camera preview active.");

    const hasMicTrack = stream.getAudioTracks().length > 0;
    if (hasMicTrack) {
      micAudioContext = new AudioContext();
      await micAudioContext.resume();
      const source = micAudioContext.createMediaStreamSource(stream);
      micAnalyser = micAudioContext.createAnalyser();
      micAnalyser.fftSize = 1024;
      source.connect(micAnalyser);
      startWaveform(micAnalyser, micCanvasEl, MIC_WAVEFORM_STYLE, (id) => {
        micAnimationId = id;
      });
      setTextContent(micStatusEl, "Listening to microphone.");
      logEvent("Microphone monitoring active.");
    } else {
      setTextContent(micStatusEl, "No microphone track detected.");
      logEvent("No microphone track detected in media stream.", "error");
    }

    if (!gesturesLocked) {
      void startGestureRecognition();
    } else {
      setGestureStatus("Gestures locked while agent active.");
    }
    logEvent("Camera and microphone streams ready.");

    return true;
  } catch (error) {
    console.error("Failed to start camera/microphone preview", error);
    setTextContent(
      cameraStatusEl,
      `Camera access failed: ${formatError(error)}`,
    );
    setTextContent(micStatusEl, "Microphone inactive.");
    logEvent(
      `Failed to start camera/microphone preview: ${formatError(error)}`,
      "error",
    );
    return false;
  }
}

async function ensureCapture(): Promise<boolean> {
  if (cameraStream) {
    return true;
  }

  return startCameraAndMic();
}

async function stopCameraAndMic() {
  let stoppedSomething = false;
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    stoppedSomething = true;
  }

  if (videoEl) {
    videoEl.srcObject = null;
  }

  stopWaveform(micCanvasEl, micAnimationId, (id) => {
    micAnimationId = id;
  });
  micAnalyser = null;

  if (micAudioContext) {
    await micAudioContext.close().catch(() => undefined);
    micAudioContext = null;
    stoppedSomething = true;
  }

  stopGestureRecognition();

  if (stoppedSomething) {
    logEvent("Camera and microphone streams stopped.");
  }
}

async function registerAgent() {
  if (!statusMsgEl || !startBtnEl || !stopBtnEl) {
    return;
  }

  if (!permissionsGranted) {
    setTextContent(
      statusMsgEl,
      "Grant camera and microphone access before starting the agent.",
    );
    logEvent(
      "Agent start blocked: camera/microphone permissions not granted.",
      "error",
    );
    return;
  }

  const captureReady = await ensureCapture();
  if (!captureReady) {
    setTextContent(
      statusMsgEl,
      "Unable to access camera and microphone. Check permissions and try again.",
    );
    logEvent(
      "Agent start blocked: unable to access camera/microphone streams.",
      "error",
    );
    return;
  }

  const screenName = getScreenNameFromWheels();
  if (!screenName) {
    statusMsgEl.textContent =
      "Please configure your screen name using the wheels.";
    logEvent("Agent start blocked: screen name is blank.", "error");
    return;
  }
  if (screenName.length < 3) {
    statusMsgEl.textContent = "Screen name must be at least 3 characters.";
    logEvent(
      "Agent start blocked: screen name shorter than 3 characters.",
      "error",
    );
    return;
  }

  setTextContent(statusMsgEl, `Starting agent for ${screenName}...`);
  logEvent(`Starting agent for ${screenName}…`);
  setButtonDisabled(startBtnEl, true);
  setButtonDisabled(stopBtnEl, false);
  setWheelsLocked(true);
  setGesturesLocked(true);

  try {
    const response = await invoke("register_agent", {
      screenName,
      screen_name: screenName,
    });
    const message = String(response);
    setTextContent(statusMsgEl, message);
    logEvent(message);
    startAutoTranscriptionLoop(500);
  } catch (error) {
    setWheelsLocked(false);
    setGesturesLocked(false);
    const formattedError = `Agent start failed: ${formatError(error)}`;
    setTextContent(statusMsgEl, `Error: ${formatError(error)}`);
    logEvent(formattedError, "error");
    setButtonDisabled(startBtnEl, false);
    setButtonDisabled(stopBtnEl, true);
  }
}

async function stopAgent() {
  if (!statusMsgEl || !startBtnEl || !stopBtnEl) {
    return;
  }

  stopAutoTranscriptionLoop();
  setTextContent(statusMsgEl, "Stopping agent...");
  logEvent("Stopping agent…");

  try {
    const response = await invoke("stop_agent");
    const message = String(response);
    setTextContent(statusMsgEl, message);
    logEvent(message);
    setWheelsLocked(false);
    setGesturesLocked(false);
  } catch (error) {
    const formattedError = `Agent stop failed: ${formatError(error)}`;
    setTextContent(statusMsgEl, `Error: ${formatError(error)}`);
    logEvent(formattedError, "error");
  } finally {
    stopAutoTranscriptionLoop();
    setButtonDisabled(startBtnEl, false);
    setButtonDisabled(stopBtnEl, true);
  }
}

async function ensurePermissions(): Promise<boolean> {
  if (permissionsGranted) {
    logEvent("Camera and microphone permissions already granted.");
    return true;
  }

  setPreflightState(
    "permissions",
    "running",
    "Requesting access to camera and microphone…",
  );
  setPreflightStatusText("Requesting camera and microphone access…");
  if (preflightPermissionsBtnEl) {
    preflightPermissionsBtnEl.disabled = true;
  }

  const success = await startCameraAndMic();
  if (success) {
    permissionsGranted = true;
    setPreflightState(
      "permissions",
      "success",
      "Camera and microphone are ready.",
    );
    setPreflightStatusText(
      "All checks passed. Opening the companion experience…",
    );
    setButtonDisabled(startBtnEl, false);
    setButtonDisabled(stopBtnEl, true);
    logEvent("Camera and microphone permissions granted.");
    return true;
  }

  setPreflightState(
    "permissions",
    "error",
    "Permission request failed. Allow access in the prompt and try again.",
    "Access required",
  );
  setPreflightStatusText(
    "We couldn’t access the camera or microphone. Allow access and try again.",
  );
  if (preflightPermissionsBtnEl) {
    preflightPermissionsBtnEl.disabled = false;
  }
  logEvent(
    "Camera and microphone permission request failed.",
    "error",
  );
  return false;
}

function completePreflight() {
  if (preflightCompleted) {
    return;
  }
  preflightCompleted = true;
  toggleAppVisibility(true);
  setPreflightStatusText("");
  logEvent("Preflight checks completed.");
}

async function initializeApp() {
  const query = <T extends HTMLElement>(id: string): T | null =>
    document.getElementById(id) as T | null;

  startBtnEl = query<HTMLButtonElement>("start-btn");
  stopBtnEl = query<HTMLButtonElement>("stop-btn");
  transcribeBtnEl = query<HTMLButtonElement>("transcribe-btn");
  statusMsgEl = query("status-msg");
  videoEl = query<HTMLVideoElement>("camera-preview");
  cameraStatusEl = query("camera-status");
  micCanvasEl = query<HTMLCanvasElement>("mic-waveform");
  micStatusEl = query("mic-status");
  backgroundPromptEl = query("background-prompt");
  backgroundImageEl = query<HTMLImageElement>("background-image-preview");
  backgroundImageStatusEl = query("background-image-status");
  preflightScreenEl = query("preflight-screen");
  appContentEl = query("app-content");
  preflightStatusEl = query("preflight-status");
  preflightPermissionsBtnEl = query<HTMLButtonElement>(
    "preflight-permissions-btn",
  );
  preflightRetryBtnEl = query<HTMLButtonElement>("preflight-retry-btn");
  screenNamePreviewEl = query("screen-name-preview");
  wheelsContainerEl = query("screen-name-wheels");
  gestureStatusEl = query("gesture-status");
  activeWheelStatusEl = query("active-wheel-status");
  logContainerEl = query("event-log");

  const preflightLookup: Record<
    PreflightKey,
    { row: string; status: string; message: string }
  > = {
    docker: {
      row: "preflight-docker",
      status: "preflight-docker-status",
      message: "preflight-docker-message",
    },
    dmr: {
      row: "preflight-dmr",
      status: "preflight-dmr-status",
      message: "preflight-dmr-message",
    },
    models: {
      row: "preflight-models",
      status: "preflight-models-status",
      message: "preflight-models-message",
    },
    permissions: {
      row: "preflight-permissions",
      status: "preflight-permissions-status",
      message: "preflight-permissions-message",
    },
  };

  PREFLIGHT_KEYS.forEach((key) => {
    const ids = preflightLookup[key];
    preflightElements[key].row = query(ids.row);
    preflightElements[key].status = query(ids.status);
    preflightElements[key].message = query(ids.message);
  });

  startBtnEl?.addEventListener("click", () => {
    void registerAgent();
  });
  stopBtnEl?.addEventListener("click", () => {
    void stopAgent();
  });
  transcribeBtnEl?.addEventListener("click", () => {
    void triggerTranscriptionCapture();
  });
  preflightPermissionsBtnEl?.addEventListener("click", () => {
    void handlePreflightPermissions();
  });
  preflightRetryBtnEl?.addEventListener("click", () => {
    void runPreflightChecks();
  });

  setButtonDisabled(startBtnEl, true);
  setButtonDisabled(stopBtnEl, true);
  toggleAppVisibility(false);

  initializeWheels();
  await loadSettings();
  await loadPersistedWheelState();

  logEvent("Companion initialised. Starting preflight checks…");
  void runPreflightChecks();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initializeApp();
});
