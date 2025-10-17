# GooseHack: AI-Powered Zoom Background Generator (Final Architecture)

This document outlines the final architecture for a hybrid, multi-component system that provides a seamless user experience for a real-time, AI-powered Zoom App.

## 1. System Architecture: Hub, Agent, and Client

The system consists of three distinct components that work in concert:

1.  **The Central Hub (Public Backend):** A lightweight, publicly deployed server with a stable domain name. This is the single, permanent entry point configured in the Zoom App Marketplace. Its primary responsibilities are:
    *   Serving the Zoom App frontend to the client.
    *   Handling the Zoom OAuth flow to authenticate users.
    *   Acting as a **matchmaker**: storing and retrieving the live tunnel URL for each registered user, keyed by their Zoom screen name.
    *   **Proxying background imagery** from the companion's Cloudflare tunnel to the Zoom App so the webview never calls the tunnel domain directly (avoiding content-blocker rules).
    *   Brokering the default nanobanana API key from Secret Manager and delivering it over the tunnel when an agent requests it.
    *   Tracking each agent's **last seen** activity and expiring registrations after five minutes of inactivity rather than five minutes from initial registration.

2.  **The Local Agent (Native Companion App):** A native macOS application (built with Tauri) that the user installs. It runs silently in the background and manages the user's local processing infrastructure. Its responsibilities are:
    *   Prompting the user for their Zoom screen name on first launch to use as a unique identifier.
    *   Managing the lifecycle of the local Docker containers using the `testcontainers` Rust library.
    *   Starting a Cloudflare Tunnel to create a secure, public URL for the local services.
    *   **Registering** its live tunnel URL with the Central Hub, associating it with the user's screen name.
    *   Keeping the nanobanana key purely in memory, preferring a Hub-supplied default when no user override is configured.
    *   Capturing short microphone samples, running local transcription, and generating virtual background prompts that are surfaced in the Companion UI.

3.  **The Zoom Client (Zoom App Frontend):** A standard web application (HTML/JS/CSS) that runs in a webview inside the Zoom client. This is the user-facing component during a meeting. Its responsibilities are:
    *   Loading from and authenticating against the Central Hub.
    *   Receiving the specific, live tunnel URL for the user's Local Agent from the Central Hub.
    *   Establishing a direct, real-time connection (e.g., WebSocket) to the Local Agent to stream audio data and receive generated images.

## 2. User Workflow & Data Flow

1.  **Setup:** The user installs the Companion App and uses the rotary wheels to set their Zoom screen name.
2.  **Activation:** The user clicks "Start" in the Companion App. The app starts the local Docker services and registers the generated public tunnel URL with the Central Hub, keyed by the user's normalized screen name.
3.  **In-Meeting:** The user opens the Zoom App. The app loads from the Central Hub and authenticates the user via Zoom OAuth.
4.  **Matchmaking:** The Central Hub, knowing the user's verified screen name from the Zoom SDK, retrieves or waits for the corresponding live tunnel URL.
5.  **Connection:** The Central Hub serves the client application, injecting the unique tunnel URL. The client then connects directly to the user's Local Agent for all real-time processing.
6.  **Virtual Background Loop:** The Zoom App long-polls the Hub's `/api/background/latest` endpoint. The Hub in turn locates the user's active tunnel, streams `/background/latest` from the companion, and relays the response. When a new render arrives, the Zoom App turns the proxied payload into a blob URL and calls `setVirtualBackground` so the session updates immediately. The companion continues to generate new backgrounds after each transcription+Gemma cycle.
7.  **On-Demand Transcription & Background Prompting:** From the companion UI, the user can trigger a 12-second recording. The Local Agent posts the audio to Docker Model Runner for Ultravox transcription, feeds the resulting text into the Gemma model to craft a vivid virtual background prompt, and displays the output. If the transcript is too sparse (e.g., silence or filler), the model emits a skip flag so no new background is generated.

## 3. Technology Stack

*   **Central Hub:** Node.js/Express deployed on Google Cloud Run with Firestore persistence. Axios-based proxy with retry/timeout safeguards for `/api/background/latest` long-poll requests.
*   **Local Agent (Companion App):**
    *   **Framework:** Tauri (Rust backend, web frontend).
    *   **Container Management:** The `testcontainers` Rust crate.
*   **Local Infrastructure (Managed by Agent):**
    *   **Companion HTTP API:** Axum (Rust) served from within the Tauri process.
    *   **Inference Runtime:** Docker Model Runner (llama.cpp) exposing a chat-completions API on `http://localhost:12434`.
        *   **Speech-to-Text Model:** `hf.co/ggml-org/ultravox-v0_5-llama-3_1-8b-gguf`.
        *   **Background Prompt Model:** `hf.co/unsloth/gemma-3n-e2b-it-gguf:q8_k_xl`.
    *   **Tunnel:** `cloudflare/cloudflared` (in Docker).
*   **Zoom Client (Frontend):**
    *   **Framework:** Zoom Apps SDK (JavaScript).
    *   **UI:** A lightweight web framework (e.g., Svelte, Vue, or plain JS).

## 4. Development Plan

### Milestone 1: The Central Hub

1.  - [x] Set up a Node.js/Express server.
2.  - [x] Implement the Zoom OAuth flow. (Authentication is now successful).
3.  - [x] Create an endpoint for agents to register (`POST /api/register-agent`).
4.  - [x] Create an endpoint for clients to get their agent's URL (`GET /api/get-agent-url`).
5.  - [x] Implement a simple database (e.g., Redis or a key-value store) for storing the screen-name-to-URL mapping. *(Using Firestore to persist agent registrations.)*
6.  - [x] Configure it to serve the (initially empty) Zoom App frontend.

### Milestone 2: The Local Agent (Companion App)

1.  Set up a Tauri project.
2.  Build the UI for screen-name input and Start/Stop controls. *(Completed: camera preview, mic waveform, permission gate, and iOS-style rotary wheels preset to blank.)*
3.  Implement the `testcontainers` logic in Rust to orchestrate the local Docker services (`transcriber`, `cloudflared`).
4.  Implement the logic to capture the Cloudflare URL and register it with the Central Hub keyed by screen name.
5.  **macOS Permissions:**
    *   Configure the Tauri application to request microphone and audio access permissions on macOS.
    *   This involves modifying the `Info.plist` file to include the necessary keys (`NSMicrophoneUsageDescription`) and user-facing descriptions.
6.  Plan native system-audio capture strategy for the speaker waveform (e.g., CoreAudio tap or virtual device). *(Pending)*
7.  Enforce keyboard/mouse-free UX: replace the text box with rotary wheels (alphabet, dot, dash, `@`) and later drive them via camera-based hand gestures (vertical swipes spin, horizontal swipes change wheel) so setup works without typing. *(Completed: gesture recognition via MediaPipe hands, clap-to-submit, wheel persistence, and UI polish.)*
8.  Integrate on-demand microphone transcription via Docker Model Runner with UI logging for capture latency, payload size, and transcript results. *(Completed: 12 s capture button, payload encoding, endpoint telemetry.)*
9.  Replace speaker monitor prototype with a unified event log panel covering permissions, transcription, and agent lifecycle events. *(Completed: full-width log pane with real-time updates.)*
10.  Feed captured transcripts into a background prompt generator model hosted in Docker Model Runner and surface the result in the UI. *(Completed: Gemma prompt call, logging, and virtual background prompt panel.)*
11.  Call Gemini (`gemini-2.5-flash-image`) with the generated prompt, request a 16:9 render, and display the returned preview beneath the camera feed. *(Completed: Tauri-side HTTPS integration, event logging, and UI card with image preview.)*
12.  Figure out secure Gemini key distribution so the desktop app does not require a manually provisioned key. *(Completed: Hub delivers the managed nanobanana key by default, while still honoring user-supplied overrides.)*

### Milestone 3: The Zoom Client & Local Backend

1.  Expose a lightweight local HTTP API (Axum) inside the Tauri companion to serve generated assets to the Zoom App, with long-polling support for `/background/latest`.
2.  Develop the Zoom App frontend UI.
3.  Implement the client-side logic to obtain the agent URL from the Hub, long-poll the Hub's `/api/background/latest` proxy with aggressive backoff tuning, and apply streamed images via `zoomSdk.setVirtualBackground`.

### Milestone 4: Integration

1.  Deploy the Central Hub to a public server (Google Cloud Run).
2.  Configure the Zoom Marketplace app with the Hub's stable URLs.
3.  Perform end-to-end testing of the entire user workflow, including the hub-proxied background loop and tunnel inactivity recovery.
