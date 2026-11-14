# kongyo-scan

Security scans for your own repositories, powered by [Codex Security](https://github.com/openai/codex-security) and running on any OpenAI-compatible model endpoint.

日本語の説明は [README.ja.md](./README.ja.md) にあります。

- **Bring your own models.** Point it at any endpoint that speaks the OpenAI Responses or Chat Completions API: a hosted gateway, an aggregator, or a model on your own machine.
- **Fallback built in.** Configure several providers in order. When one fails, the next takes over in the middle of a scan.
- **Local only.** The scan runs on your machine. There is no OpenAI sign-in, and findings stay on disk.
- **Two ways to use it.** Run `kongyo-scan` for an interactive UI, or use the commands with `--json` in scripts and CI.

## Requirements

- Node.js 22.13 or newer (22.x, 24.x, or 26.x)
- Python 3.10 or newer, which Codex Security needs for scans
- Git, for diff and working-tree scans
- On Linux, [Bubblewrap](https://github.com/containers/bubblewrap) and permission to create user namespaces, which the command sandbox needs. On Ubuntu this takes a one-time setup: see [Linux sandbox](#linux-sandbox)
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

### API keys

A key comes from one of three places, in this order:

1. The environment variable named by `--api-key-env`, when it is set.
2. A key stored by kongyo-scan (`--api-key-stdin`, the wizard, or `config set providers.<name>.api_key`).
3. An `api_key` written directly in a settings file.

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
- GitHub-hosted Ubuntu 24.04 runners need the [Linux sandbox](#linux-sandbox) setup in a step before the scan.

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

This writes `kongyo-scan.json`, a starter file for scope, mode, and failure policy. It is used only when you name it, with `--config kongyo-scan.json` or `KONGYO_SCAN_CONFIG`.

### Codex Security settings

Native Codex settings go under `codex`, or on the command line for one scan:

```bash
kongyo-scan scan --codex analytics.enabled=false
```

`model`, `model_provider`, `model_providers`, and `model_reasoning_effort` are managed by kongyo-scan. Use `--model`, `--effort`, and `providers` instead.

The rest of the Codex Security CLI is available with your providers and scan state:

```bash
kongyo-scan codex-security -- scans list
```

`login`, `logout`, `publish`, `feedback`, and `update` are not available.

### Where things are stored

| Path | Contents |
| --- | --- |
| `~/.kongyo-scan/config.json` | Settings |
| `~/.kongyo-scan/state/` | Codex Security state: scan history and artifacts |
| `~/.kongyo-scan/state/codex-home/kongyo-scan-credentials.json` | Stored API keys |
| `~/.kongyo-scan/history.jsonl` | One line per scan started by kongyo-scan |

Set `KONGYO_SCAN_HOME` or pass `--home <DIR>` to use another directory. kongyo-scan does not read or write your own `~/.codex`.

## Linux sandbox

Codex Security runs every command of a scan inside a sandbox. On Linux that sandbox is [Bubblewrap](https://github.com/containers/bubblewrap), which has to create user namespaces. When it can't, a scan stops before it starts:

```text
Can't start the scan. The command sandbox can't create user namespaces on this machine.
  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

`kongyo-scan doctor` runs the same check under **Sandbox** and says what is missing.

### Install Bubblewrap

Codex uses the first `bwrap` on your `PATH`, and a copy bundled with it when there is none. Install the package of your distribution, so that an AppArmor profile can apply to it:

```bash
sudo apt install bubblewrap
```

### Ubuntu 24.04: add an AppArmor profile

On Ubuntu 24.04 and later, a program may use unprivileged user namespaces only when an AppArmor profile allows it (`kernel.apparmor_restrict_unprivileged_userns=1`), and Ubuntu 24.04 has no profile for Bubblewrap. Add one for `/usr/bin/bwrap`. If `command -v bwrap` prints another path, use that path in the profile.

```bash
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
```

Reload AppArmor to apply it, then check:

```bash
sudo systemctl reload apparmor
```

```bash
kongyo-scan doctor
```

This profile lets every program started through `bwrap` use user namespaces. Ubuntu has a stricter one in the `apparmor-profiles` package, which keeps capabilities away from the programs Bubblewrap starts. Ubuntu 24.04 leaves it off because it can break some other uses of Bubblewrap. Use one profile or the other, not both: each defines a profile named `bwrap`.

```bash
sudo apt install apparmor-profiles
```

```bash
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
```

```bash
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Ubuntu 25.04 and later enable that stricter profile by default, so installing `bubblewrap` is enough there.

### Other systems

- **CI.** GitHub-hosted Ubuntu 24.04 runners have the same restriction. Run the commands above in a step before the scan.
- **Containers.** A container runtime usually blocks user namespaces inside the container. Scan on the host, or give the container a profile that allows them, as the [Codex Security Docker guide](https://github.com/openai/codex-security/blob/main/docker/README.md) does.
- **Other kernels.** Unprivileged user namespaces can also be switched off with `kernel.unprivileged_userns_clone=0` or `user.max_user_namespaces=0`. Turn them on with `sysctl`.
- **WSL.** WSL 2 works like Linux. WSL 1 can't create user namespaces.

## Development

```bash
npm install
```

```bash
node --run check
```

`check` runs the formatter check, the linter, the type checker, and the tests. Other scripts: `build`, `test`, `lint`, `lint:fix`, `format`, `format:fix`, and `schema`, which regenerates `schemas/config.schema.json` after a change to the settings schema.

## License

[MIT](./LICENSE)

kongyo-scan depends on `@openai/codex-security`, which is licensed under Apache-2.0. It is not affiliated with or endorsed by OpenAI.
