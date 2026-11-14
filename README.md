# kongyo-scan

Security scans for your own repositories, powered by [Codex Security](https://github.com/openai/codex-security) and running on any OpenAI-compatible model endpoint.

日本語の説明は [README.ja.md](./README.ja.md) にあります。

- **Bring your own models.** Point it at any endpoint that speaks the OpenAI Responses or Chat Completions API: a hosted gateway, an aggregator, or a model on your own machine.
- **Fallback built in.** Configure several providers in order. When one fails, the next takes over in the middle of a scan.
- **Local only.** The scan runs on your machine. There is no OpenAI sign-in, and findings stay on disk.
- **Two ways to use it.** Run `kongyo-scan` for an interactive UI, or use the commands with `--json` in scripts and CI.

A scan as it appears in a CI log:

```text
Repository: /work/shop-api
Scope: src
Mode: standard
Providers: primary (model-a) -> backup (model-b)
Effort: xhigh

  Preparing the scan...
  Starting Codex Security...
Scan ID: 0b9f6c1e-52d4-4f0a-9a57-3f1c2d7e8a90
  Building the threat model...
  Reviewing files... 4 files
  Validating findings...
  Writing the report...

Scan complete 3 findings (2 high, 1 medium)
Report: /home/you/.kongyo-scan/state/scans/shop-api/codex-security-shop-api-Ab12Cd/report.md
Scan ID: 0b9f6c1e-52d4-4f0a-9a57-3f1c2d7e8a90
Duration: 3m 30s
Tokens: 783,764 in (723,540 cached), 18,105 out
Severity	Location	Title
high	src/server.js:11	SQL injection in user lookup exposes stored credentials
high	src/server.js:21	Command injection in ping endpoint gives remote code execution
medium	src/server.js:30	Path traversal in report download reads arbitrary files

  Read each finding with its evidence:
    kongyo-scan scans inspect 0b9f6c1e-52d4-4f0a-9a57-3f1c2d7e8a90
```

In a terminal the same scan shows a live view with the current phase, the provider in use, token counts, and recent activity.

## Requirements

- Node.js 22.13 or newer (22.x, 24.x, or 26.x)
- Python 3.10 or newer, which Codex Security needs for scans
- Git, for diff and working-tree scans
- An API key for at least one OpenAI-compatible endpoint, or a local model server

Run `kongyo-scan doctor` to check all of this at once.

## Install

```bash
npm install --global @kongyo2/kongyo-scan
```

## Quick start

Open the interactive UI in the repository you want to scan:

```bash
kongyo-scan
```

The first screen offers to add a provider, then to scan. Everything the UI does is also a command.

Without the UI, add a provider and scan:

```bash
printenv OPENCODE_API_KEY | kongyo-scan providers add --preset opencode-go --model <MODEL> --api-key-stdin
```

```bash
kongyo-scan scan
```

## Providers

A provider is one endpoint plus one model. Providers are kept in order; the first enabled one is the primary and the rest are fallbacks.

```bash
kongyo-scan providers add
```

In a terminal this starts a short wizard: pick a preset or enter a base URL, give the key, pick a model from the endpoint's own list, and the endpoint is tested with a real request before anything is saved.

The same with flags, for scripts:

```bash
kongyo-scan providers add my-gateway --base-url https://api.example.com/v1 --model <MODEL> --api-key-env MY_GATEWAY_KEY
```

| Command | What it does |
| --- | --- |
| `providers list` | Show providers in fallback order |
| `providers add [name]` | Add an endpoint; tests it first |
| `providers update <provider>` | Change the model, URL, key, headers, or name |
| `providers move <provider> --first` | Change the fallback order (`--first`, `--last`, `--position <N>`) |
| `providers disable <provider>` / `enable` | Take a provider out of the chain without deleting it |
| `providers check [provider]` | Send a test request that asks the model to call a tool |
| `providers models [provider]` | List the model IDs the endpoint offers |
| `providers remove <provider>` | Remove a provider and its stored key |

Presets fill in the base URL and API type: `opencode-go`, `opencode`, `logfare`, `openrouter`, `fireworks`, `deepseek`, `groq`, `ollama`, `lmstudio`. Any other endpoint works with `--base-url`.

### Responses and Chat Completions

Codex speaks only the Responses API. kongyo-scan accepts both:

- `--wire-api responses` sends requests to `POST {base_url}/responses`.
- `--wire-api chat` translates each request to `POST {base_url}/chat/completions` and translates the streamed answer back, including tool calls and reasoning.

Leave `--wire-api` out and both are probed; the one that works is saved.

Endpoints other than OpenAI's own usually accept only part of the Responses API. For those, kongyo-scan sends the portable part: namespaced tools become plain function tools, hosted tools such as web search are left out, and messages between Codex agents become ordinary messages. Answers are mapped back, so Codex notices no difference. Requests to `api.openai.com` keep OpenAI's native shape. Set `compat.native_responses` on a provider to choose either behavior yourself.

### API keys

A key comes from one of three places, in this order:

1. The environment variable named by `--api-key-env`, when it is set.
2. A key stored by kongyo-scan (`--api-key-stdin`, the wizard, or `config set providers.<name>.api_key`).
3. An `api_key` written directly in a settings file. This works, but scans can read that file; `kongyo-scan doctor` warns about it.

Stored keys go to a separate file that only you can read, inside the one directory the scan sandbox is denied. A scan agent that wanders outside the repository cannot read them. Keys are masked everywhere they are shown and are never passed to Codex or to the commands a scan runs.

### Fallback

During a scan, each model request goes to the first healthy provider. kongyo-scan moves to the next provider when one:

- rejects the key, is out of quota, or does not know the model
- is rate limited or returns a server error
- cannot be reached, or sends nothing before the timeout (`timeout_seconds`, 180 by default)

A failing provider is skipped for a while (`gateway.cooldown_seconds`, 60 by default) and then tried again. If a provider breaks off in the middle of an answer, that response is ended and Codex retries the request, which then goes to the next healthy provider.

A request that is too large for one model's context is tried on the next provider without marking the first one as failing. When no provider accepts it, Codex is told, and it compacts the conversation and continues.

Choose the chain for one scan with `--provider`, or turn fallback off:

```bash
kongyo-scan scan --provider logfare,opencode-go
```

```bash
kongyo-scan scan --no-fallback
```

### A provider from environment variables

For CI, a provider can be defined without a settings file. It is named `env` and is tried first.

| Variable | Meaning |
| --- | --- |
| `KONGYO_SCAN_BASE_URL` | Endpoint base URL |
| `KONGYO_SCAN_MODEL` | Model ID |
| `KONGYO_SCAN_API_KEY` | API key |
| `KONGYO_SCAN_WIRE_API` | `responses` or `chat` (default: `chat`) |

## Scanning

```bash
kongyo-scan scan [repository]
```

| Scope | Option |
| --- | --- |
| The whole repository | none |
| Selected files or directories | `--path src,lib/auth.ts` |
| Committed changes since a revision | `--diff origin/main` (and `--head <REF>`) |
| Staged and unstaged changes | `--working-tree` (and `--base <REF>`) |

Other options you will reach for:

| Option | Meaning |
| --- | --- |
| `--mode deep` | Run a deep scan with parallel workers (`--workers`, `--subagents`, `--max-discovery-runs`, `--stop-after-no-new`) |
| `--effort <VALUE>` | Reasoning effort passed to the model, such as `low`, `high`, `xhigh`, or `max`. `default` sends none |
| `--model <NAME>` | Model for the first provider in the chain |
| `--fail-on-severity high` | Exit with code 1 when a finding at or above this severity is reported |
| `--max-cost <USD>` | Stop once the estimated cost passes this amount; every provider needs `pricing` |
| `--knowledge-base`, `--scan-prompt-file`, `--validation-prompt-file`, `--post-scan-prompt-file`, `--rubric` | Extra context and instructions for Codex Security |
| `--output <DIR>` | Where to write artifacts, outside the repository |
| `--dry-run` | Validate everything and show what would run |
| `--json` | Print one JSON document on stdout |

`kongyo-scan scan --help` lists every option.

### Results

Each scan writes a Markdown report, `findings.json`, SARIF, and the threat model under `~/.kongyo-scan/state`.

```bash
kongyo-scan scans list
```

```bash
kongyo-scan scans inspect
```

```bash
kongyo-scan scans export --format sarif --output results.sarif
```

`inspect`, `report`, and `export` take a scan ID or a unique prefix. Without one they use the latest completed scan of the current directory. Export formats are `sarif`, `json`, `markdown`, `csv`, and `threat-model`.

### In CI

```bash
kongyo-scan scan --diff origin/main --fail-on-severity high --json > scan.json
```

- Results go to stdout. Progress, receipts, and errors go to stderr.
- With `--json`, stdout holds exactly one JSON document, and a failure is one JSON document on stderr.
- Nothing prompts when there is no terminal, in CI, or with `--non-interactive`.

| Exit code | Meaning |
| --- | --- |
| 0 | The command succeeded. For a scan: it completed and no finding met `--fail-on-severity` |
| 1 | The command failed, or findings met `--fail-on-severity` |
| 2 | The command line or a required input was wrong |
| 130 | Canceled with Ctrl+C |

## Settings

Settings live in `~/.kongyo-scan/config.json`. Change them with commands or in the UI.

```bash
kongyo-scan config set reasoning_effort max
```

```bash
kongyo-scan config set policy.fail_on_severity high
```

```bash
kongyo-scan config keys
```

| Setting | Meaning |
| --- | --- |
| `providers` | Endpoints in fallback order. Each has `name`, `base_url`, `model`, `wire_api`, `api_key_env`, `headers`, `query_params`, `reasoning_effort`, `context_window`, `max_output_tokens`, `timeout_seconds`, `pricing`, `compat`, `disabled` |
| `reasoning_effort` | Effort for scans (default: `xhigh`) |
| `scan.mode`, `scan.scope`, `scan.max_time_minutes` | Scan defaults |
| `scan.knowledge_base`, `scan.instructions_file`, `scan.validation_file`, `scan.post_scan_file`, `scan.rubric_file`, `scan.owner_suggestions` | Codex Security inputs |
| `scan.deep.*` | Deep-scan workers, subagents, and stop conditions |
| `limits.max_cost_usd_per_scan` | Cost limit per scan |
| `policy.fail_on_severity` | Severity that makes a scan exit with code 1 |
| `output.directory` | Where scan artifacts go |
| `codex.*` | Native Codex settings passed through, such as `codex.analytics.enabled` |
| `python` | Python interpreter for Codex Security |
| `gateway.*` | Local gateway port, cooldown, idle timeout, and retries |

A JSON Schema for editors ships with the package as `schemas/config.schema.json`.

### Settings for one repository

```bash
kongyo-scan init
```

This writes `kongyo-scan.json`, a starter file for scope, mode, and failure policy. It is used only when you name it, with `--config kongyo-scan.json` or `KONGYO_SCAN_CONFIG`. kongyo-scan never picks up a settings file from the repository being scanned on its own, so a repository cannot change how it is scanned.

### Codex Security settings

Native Codex settings go under `codex`, or on the command line for one scan:

```bash
kongyo-scan scan --codex analytics.enabled=false
```

kongyo-scan manages a few of them itself, such as `model`, `model_provider`, `model_providers`, and `model_reasoning_effort`, because the provider chain depends on them. Use `--model`, `--effort`, and `providers` instead.

The rest of the Codex Security CLI is available with your providers and scan state:

```bash
kongyo-scan codex-security -- scans list
```

`login`, `logout`, `publish`, `feedback`, and `update` are not available, because kongyo-scan is local-only.

### Where things are stored

| Path | Contents |
| --- | --- |
| `~/.kongyo-scan/config.json` | Settings |
| `~/.kongyo-scan/state/` | Codex Security state: scan history and artifacts |
| `~/.kongyo-scan/state/codex-home/kongyo-scan-credentials.json` | Stored API keys, readable only by you and denied to scans |
| `~/.kongyo-scan/history.jsonl` | One line per scan started by kongyo-scan |

Set `KONGYO_SCAN_HOME` or pass `--home <DIR>` to use another directory. kongyo-scan does not read or write your own `~/.codex`.

## How it works

Codex Security drives the Codex agent, and Codex talks to exactly one model provider over the Responses API. kongyo-scan starts a small gateway on `127.0.0.1` for the length of a scan and tells Codex to use it. The gateway:

- relays each request to the first healthy provider and falls back down the chain
- translates between the Responses API and Chat Completions for endpoints that only speak chat
- adapts tool definitions and reasoning to what each endpoint accepts
- keeps a scan going when a model answers with a progress note instead of a tool call, which would otherwise end the scan early
- counts tokens and estimates cost per provider

The gateway listens only on the loopback interface and requires a token that is created for each scan.

## Security notes

- Scans send source code from the scanned repository to the providers you configure. Use providers you trust with that code.
- Codex Security runs scan commands in its sandbox with write access limited to the workspace. It can read other files on the machine, which is why stored keys are kept in the one directory it is denied.
- `OPENAI_API_KEY`, `CODEX_API_KEY`, and the key variables of your providers are removed from the environment that Codex and its commands see.
- Findings are produced by a model. Review them before acting on them.

## Development

```bash
npm install
```

```bash
node --run check
```

`check` runs the formatter check, the linter, the type checker, and the tests. Other scripts: `build`, `test`, `lint`, `lint:fix`, `format`, `format:fix`, and `schema`, which regenerates `schemas/config.schema.json` after a change to the settings schema.

### Publishing

Publishing is a manual GitHub Actions workflow, **Publish to npm** (`.github/workflows/publish.yml`).

1. Set the new version in `package.json` and push it.
2. Open **Actions**, choose **Publish to npm**, and select **Run workflow**. Pick the dist-tag (`latest` by default). Tick **dry-run** to build and verify without publishing.

The workflow runs every check, refuses a version that is already on npm, and publishes `@kongyo2/kongyo-scan` with public access. It authenticates in one of two ways:

- **Token**: add an npm access token that may publish to the `@kongyo2` scope as the repository secret `NPM_TOKEN`. The first publish of the package needs this.
- **Trusted Publishing**: once the package exists, add this repository and `publish.yml` as a trusted publisher in the package settings on npmjs.com. No secret is needed after that.

## License

[MIT](./LICENSE)

kongyo-scan depends on `@openai/codex-security`, which is licensed under Apache-2.0. It is not affiliated with or endorsed by OpenAI.
