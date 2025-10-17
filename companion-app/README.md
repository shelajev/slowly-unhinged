# Slowly Unhinged Companion

This Tauri application provides the local companion experience for GooseHack. It handles the preflight checks, camera/microphone capture, manual transcription trigger, virtual background prompting, and gesture-based screen name input.

## Running Locally

```bash
npm install
npm run tauri dev
```

The dev command launches Vite in watch mode and starts the Tauri shell. Use `npm run build` to produce a production bundle.

## Settings File

The app persists user preferences and runtime state in `~/Library/Application Support/com.slowlyunhinged.agent/settings.json` (created on first launch).

### Editable Fields

- `model_transcription`: ID of the Docker Model Runner speech model. Update this to switch the transcription engine.
- `model_prompt`: ID of the prompt-generation model served by Docker Model Runner.
- `nanobanana_api_key`: Optional API key stored locally for Nano Banana image generation.
- `wheels`: Internal state for the on-screen name wheels (`positions` array and `active_index`). You can reset the wheels by deleting this block or removing the settings file.

Changes take effect the next time the companion app loads the settings (on launch).
