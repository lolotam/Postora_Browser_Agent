# Postora workspace, bilingual voice, and chat surface

Approved direction: the user's 2026-11-05 answers select automatic Arabic/English
transcription, the supplied ChatGPT extension screenshot with existing Postora
functions, and project read/write/command execution. No new Chat/Work split.

Reference lock: supplied screenshot owns the composition (open chat, rounded
bottom composer, compact borderless model control); Refero ChatGPT style
667cf5b9-5940-4db5-a972-fb6bd51d5783 owns neutral surfaces and outline controls;
shadcn style c14c0a94-1037-449e-bf5b-4cb972656ac7 contributes settings hierarchy.
Cairo is bundled locally under OFL for Arabic; code remains monospace. Preserve
dark mode, RTL, all settings, session selection, and accessible focus rings.

Access changes add a small persistent conversation event while live permissions
remain worker-authoritative. Replays never grant permission. Upgrade continues;
downgrade/Stop cancel. Existing per-chat restart behavior remains.

Automatic speech uses MediaRecorder plus an explicitly configured transcription
endpoint, not browser recognition tied to the interface language. Default endpoint
is OpenAI audio/transcriptions and model gpt-transcribe; compatible/local endpoints
are configurable. Do not send a forced language or use the translations endpoint.
Record bounded utterances, stop during output, cancel stale requests, and never
execute a transcript from a closed recorder. Spoken output follows text language.
Missing service credentials are shown as setup instructions, never silent English
fallback. Existing browser recognition remains an explicit alternative.

Each chat may bind one user-chosen local project through the private native host.
Expose project_list/read/write/run and @file context selection. Roots come from
trusted panel messages, never model tool arguments. Resolve real paths and reject
traversal, links outside the root, and conflicting writes. Exclude .git, dependencies,
build output and secret files from listings by default. Explicit reads remain possible
under the access policy. Commands run with the project cwd as the current Windows
user; this is not an OS sandbox. Show this in project controls. No whole-project
upload; only requested file content reaches configured model providers.

Validation: unit coverage for permissions, root/path confinement, conflict detection,
speech cancellation and multilingual request/response; real extension fixture tests
for mode notice, composer, project binding and mocked transcription. Run the complete
unit and browser suites, private packaging, and whitespace checks.
