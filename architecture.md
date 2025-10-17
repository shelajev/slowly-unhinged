# System Architecture

This document outlines the architecture for a hybrid, multi-component system that provides a seamless user experience for a real-time, AI-powered Zoom App.

The system consists of three distinct components that work in concert:

1.  **The Central Hub (Public Backend):** A lightweight, publicly deployed server with a stable domain name. This is the single, permanent entry point configured in the Zoom App Marketplace. Its primary responsibilities are:
    *   Serving the Zoom App frontend to the client.
    *   Handling the Zoom OAuth flow to authenticate users.
    *   Acting as a **matchmaker**: storing, refreshing, and retrieving the live tunnel URL for each registered user, with a five-minute inactivity TTL enforced via a `lastSeenAt` timestamp.
    *   Proxying background imagery from the companion's Cloudflare tunnel so the Zoom App never calls the tunnel domain directly.
    *   Supplying a default nanobanana API key sourced from Secret Manager to agents that opt in during tunnel registration.

2.  **The Local Agent (Native Companion App):** A native macOS application (built with Tauri) that the user installs. It runs silently in the background and manages the user's local processing infrastructure. Its responsibilities are:
    *   Prompting the user for their Zoom screen name on first launch to use as a unique identifier.
    *   Managing the lifecycle of the local Docker containers using the `testcontainers` Rust library.
    *   Starting a Cloudflare Tunnel to create a secure, public URL for the local services.
    *   **Registering** its live tunnel URL with the Central Hub, associating it with the user's screen name.
    *   Receiving the Hub-provided nanobanana key over the tunnel (when no local key is present) and retaining it only in volatile memory.
    *   Capturing on-demand microphone samples, orchestrating local inference for transcription and virtual background prompt generation, and surfacing those results in the companion UI.

3.  **The Zoom Client (Zoom App Frontend):** A standard web application (HTML/JS/CSS) that runs in a webview inside the Zoom client. This is the user-facing component during a meeting. Its responsibilities are:
    *   Loading from and authenticating against the Central Hub.
    *   Receiving the specific, live tunnel URL for the user's Local Agent from the Central Hub.
    *   Long-polling the Hub's `/api/background/latest` endpoint with tight backoff so new renders arrive immediately, while other real-time interactions can continue over the tunnel when permitted.

## Deployment Architecture (Central Hub)

The Central Hub will be deployed on the Google Cloud Platform (GCP) using a serverless architecture to ensure scalability and cost-effectiveness.

1.  **Compute (Google Cloud Run):** The Node.js/Express application will be packaged into a Docker container and deployed on Cloud Run. This provides a fully managed, auto-scaling, and secure HTTPS endpoint.
2.  **Database (Google Firestore):** Firestore stores the temporary mapping between a user's normalized screen name and their live tunnel URL. Its serverless nature and seamless integration with Cloud Run make it an ideal choice.
3.  **Secrets (Google Secret Manager):** All sensitive credentials, such as the Zoom App's Client ID and Secret, will be stored securely in Google Secret Manager. The Cloud Run service will be granted the necessary IAM permissions to access these secrets at runtime.

## Local Operating Model (Agent & Docker Model Runner)

The Companion App manages a Docker Model Runner (DMR) instance that exposes inference endpoints on `http://localhost:12434`. Through this single runtime, the app loads and serves multiple GGUF models:

* `hf.co/ggml-org/ultravox-v0_5-llama-3_1-8b-gguf` for speech-to-text transcription of 12-second microphone samples.
* `hf.co/unsloth/gemma-3n-e2b-it-gguf:q8_k_xl` for transforming transcripts into vivid virtual background prompts.

Both models use the same llama.cpp-compatible `/engines/llama.cpp/v1/chat/completions` API surface, enabling consistent request/response handling across tasks.

## End-to-End Data Flow

1. **Permission & Setup:** The user launches the Companion App, grants camera/microphone access, and dials in their screen name using gesture-controlled rotary wheels.
2. **Agent Registration:** On "Start," the app uses `testcontainers` to launch the DMR and `cloudflared` containers, then registers the generated tunnel URL with the Central Hub keyed to the user's screen name. An in-process Axum server binds to the companion port and becomes the tunnel target.
3. **Meeting Join:** Inside Zoom, the user opens the Zoom App frontend served by the Hub, which looks up (and if needed, waits for) the matching tunnel URL and relays it to the client UI.
4. **Background Proxy Loop:** The Zoom App begins long-polling the Hub's `/api/background/latest` endpoint. For each call the Hub resolves the active tunnel, updates its `lastSeenAt`, and forwards the long-poll to the companion's `/background/latest`. Responses (including `204` heartbeats) are streamed straight back to the Zoom App.
5. **On-Demand Transcription:** When the user presses "Record & Transcribe," the Companion App records a 12-second microphone sample, resamples it to 16 kHz mono, and posts it to the DMR Ultravox model. The response is logged and displayed in the UI.
6. **Background Prompt Generation:** The returned transcript becomes the user message for a second DMR request against the Gemma model. The system-level prompt instructs Gemma to craft an image-generation prompt referencing memorable but non-identifying elements from the transcript. The generated text is shown in the "Virtual Background Prompt" panel and logged for traceability.
7. **Remote Image Rendering:** The Tauri backend now forwards the generated prompt to Google's Gemini image endpoint (`gemini-2.5-flash-image`) to render a 16:9 virtual background. The request is executed from the Rust side to keep the API key out of the webview. Successful responses are cached in memory and exposed via the Axum long-poll endpoint (`GET /background/latest`). The Hub proxies that stream to the Zoom App, which converts the bytes into a blob URL and invokes `zoomSdk.setVirtualBackground`. When the prompt model judges a transcript as too sparse (silence, filler, <8 words), it emits a skip signal so no new background is published.

This loop can be repeated during the meeting, giving participants bespoke virtual background ideas tied directly to their recent conversation, while keeping all processing on the user's local machine.

## Technology Stack Summary

* **Central Hub:** Node.js/Express on Google Cloud Run, backed by Firestore and Secret Manager, with Axios-based retry/timeout proxying for `/api/background/latest` and activity-aware tunnel expiration.
* **Companion UI & API:** Vite + TypeScript frontend embedded in a Tauri shell for macOS. A co-located Axum (Rust) HTTP server exposes generated assets to the Zoom App.
* **Inference Runtime:** Docker Model Runner (llama.cpp) hosting the Ultravox STT and Gemma prompt-generation models. Gemini image generation is performed via HTTPS from the Tauri backend.
* **Auxiliary Services:** `cloudflare/cloudflared` tunnel orchestrated through `testcontainers`.
* **Zoom Client:** Zoom Apps SDK application that consumes the Hub API, aggressively polls `/api/background/latest`, and applies streamed images using `zoomSdk.setVirtualBackground`.

## Gemini API Key Handling

Gemini access is confined to the Tauri backend so the API key never reaches the browser surface. The key is resolved first from the desktop app's `settings.json` (for example, `~/Library/Application Support/com.slowlyunhinged.agent/settings.json`) where users can supply `nanobananaApiKey`. If no override is present, the runtime consults the `NANOBANANA_API_KEY` environment variable and then the volatile secret delivered by the Hub over the tunnel. As a last resort, the legacy plaintext `nanobanana_api_key.txt` in the config directory is read. The Hub stores its default key in Secret Manager and streams it through a control endpoint so the value is never written to disk or included in logs.
