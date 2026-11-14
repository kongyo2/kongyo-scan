# kongyo-scan

自分のリポジトリを対象にしたセキュリティスキャンCLIです。[Codex Security](https://github.com/openai/codex-security) を、任意のOpenAI互換モデルエンドポイントで動かします。

English: [README.md](./README.md)

- **モデルは自由に選べます。** OpenAIのResponses APIまたはChat Completions APIを話すエンドポイントなら、ホスト型ゲートウェイでも、アグリゲーターでも、手元のモデルサーバーでも使えます。
- **フォールバック内蔵。** プロバイダーを順番に複数登録しておくと、1つが失敗したときにスキャンの途中でも次へ切り替わります。
- **ローカル実行のみ。** スキャンは手元のマシンで動きます。OpenAIへのサインインは不要で、検出結果はディスクに残るだけです。
- **使い方は2通り。** `kongyo-scan` だけで対話UIが開きます。スクリプトやCIでは各コマンドに `--json` を付けて使えます。

## 必要なもの

- Node.js 22.13 以上（22.x / 24.x / 26.x）
- Python 3.10 以上（Codex Security がスキャンに使います）
- Git（差分スキャン・作業ツリースキャンに必要）
- Linux では [Bubblewrap](https://github.com/containers/bubblewrap) と、ユーザー名前空間を作成できること（コマンドのサンドボックスに必要）。Ubuntu では最初に一度だけ設定が要ります。[Linux のサンドボックス](#linux-sandbox) を参照
- OpenAI互換エンドポイントのAPIキーを1つ以上、またはローカルのモデルサーバー

`kongyo-scan doctor` でまとめて確認できます。

## インストール

```bash
npm install --global @kongyo2/kongyo-scan
```

## クイックスタート

スキャンしたいリポジトリで対話UIを開きます。

```bash
kongyo-scan
```

最初の画面でプロバイダーを追加し、そのままスキャンを始められます。UIでできることは、すべてコマンドでもできます。

UIを使わない場合は、プロバイダーを追加してからスキャンします。

```bash
printenv OPENCODE_API_KEY | kongyo-scan providers add --preset opencode-go --model <MODEL> --api-key-stdin
```

```bash
kongyo-scan scan
```

## プロバイダー

プロバイダーは「エンドポイント1つ＋モデル1つ」の組です。登録順がそのままフォールバック順で、有効な先頭がプライマリ、残りがフォールバックになります。

```bash
kongyo-scan providers add
```

ターミナルではウィザードが始まります。プリセットを選ぶかベースURLを入力し、キーを入れ、エンドポイントが返すモデル一覧から選ぶと、保存前に実際のリクエストで疎通を確認します。

スクリプト向けに、同じことをフラグでも指定できます。

```bash
kongyo-scan providers add my-gateway --base-url https://api.example.com/v1 --model <MODEL> --api-key-env MY_GATEWAY_KEY
```

| コマンド | 内容 |
| --- | --- |
| `providers list` | フォールバック順にプロバイダーを表示 |
| `providers add [name]` | エンドポイントを追加（保存前に疎通確認） |
| `providers update <provider>` | モデル・URL・キー・ヘッダー・名前を変更 |
| `providers move <provider> --first` | フォールバック順を変更（`--first` / `--last` / `--position <N>`） |
| `providers disable <provider>` / `enable` | 削除せずにチェーンから外す／戻す |
| `providers check [provider]` | ツール呼び出しを含むテストリクエストを送る |
| `providers models [provider]` | エンドポイントが提供するモデルIDを一覧 |
| `providers remove <provider>` | プロバイダーと保存済みキーを削除 |

プリセットはベースURLとAPI種別を自動で埋めます: `opencode-go`、`opencode`、`logfare`、`openrouter`、`fireworks`、`deepseek`、`groq`、`ollama`、`lmstudio`。それ以外のエンドポイントは `--base-url` で指定します。

### Responses と Chat Completions

Codex が話せるのは Responses API だけですが、kongyo-scan は両方に対応します。

- `--wire-api responses` は `POST {base_url}/responses` に送ります。
- `--wire-api chat` はリクエストを `POST {base_url}/chat/completions` 用に変換し、ストリーミングの応答（ツール呼び出しや推論を含む）を Responses の形に戻します。

`--wire-api` を省略すると両方を試し、動いたほうを保存します。

### APIキー

キーは次の順で探します。

1. `--api-key-env` で指定した環境変数（設定されていれば最優先）
2. kongyo-scan が保存したキー（`--api-key-stdin`、ウィザード、または `config set providers.<name>.api_key`）
3. 設定ファイルに直接書いた `api_key`

### フォールバック

スキャン中、各モデルリクエストは健全な先頭のプロバイダーへ送られます。次の場合に次のプロバイダーへ移ります。

- キーが拒否された、クォータ切れ、モデルが存在しない
- レート制限、またはサーバーエラー
- 接続できない、またはタイムアウトまで何も返ってこない（`timeout_seconds`、既定180秒）

失敗したプロバイダーはしばらく飛ばされ（`gateway.cooldown_seconds`、既定60秒）、その後もう一度試されます。応答の途中で切れた場合は、その応答を終了させて Codex に再試行させ、再試行は次の健全なプロバイダーへ向かいます。

あるモデルのコンテキスト長に収まらないリクエストは、そのプロバイダーを不調扱いにせず次のプロバイダーで試します。どこも受け付けない場合は Codex に伝わり、Codex が会話を圧縮して続行します。

スキャンごとにチェーンを指定したり、フォールバックを切ったりできます。

```bash
kongyo-scan scan --provider logfare,opencode-go
```

```bash
kongyo-scan scan --no-fallback
```

### 環境変数だけで定義するプロバイダー

CI向けに、設定ファイルなしでプロバイダーを定義できます。名前は `env` になり、最初に試されます。

| 変数 | 意味 |
| --- | --- |
| `KONGYO_SCAN_BASE_URL` | エンドポイントのベースURL |
| `KONGYO_SCAN_MODEL` | モデルID |
| `KONGYO_SCAN_API_KEY` | APIキー |
| `KONGYO_SCAN_WIRE_API` | `responses` または `chat`（既定: `chat`） |

## スキャン

```bash
kongyo-scan scan [repository]
```

| 対象 | オプション |
| --- | --- |
| リポジトリ全体 | なし |
| 指定したファイルやディレクトリ | `--path src,lib/auth.ts` |
| あるリビジョン以降のコミット済み変更 | `--diff origin/main`（`--head <REF>` も可） |
| ステージ済み・未ステージの変更 | `--working-tree`（`--base <REF>` も可） |

よく使うオプション:

| オプション | 意味 |
| --- | --- |
| `--mode deep` | 並列ワーカーによるディープスキャン（`--workers`、`--subagents`、`--max-discovery-runs`、`--stop-after-no-new`） |
| `--effort <VALUE>` | モデルに渡す推論エフォート（`low`、`high`、`xhigh`、`max` など）。`default` は何も送りません |
| `--model <NAME>` | チェーン先頭のプロバイダーで使うモデル |
| `--fail-on-severity high` | この深刻度以上の検出があれば終了コード1 |
| `--max-cost <USD>` | 推定コストがこの額を超えたら停止（全プロバイダーに `pricing` が必要） |
| `--knowledge-base`、`--scan-prompt-file`、`--validation-prompt-file`、`--post-scan-prompt-file`、`--rubric` | Codex Security に渡す追加コンテキストと指示 |
| `--output <DIR>` | 成果物の出力先（リポジトリの外） |
| `--dry-run` | 入力を検証し、実行内容を表示するだけ |
| `--json` | 標準出力にJSONを1つだけ出力 |

全オプションは `kongyo-scan scan --help` で確認できます。

### 結果

スキャンごとに、Markdownレポート、`findings.json`、SARIF、脅威モデルが `~/.kongyo-scan/state` 以下に保存されます。

```bash
kongyo-scan scans list
```

```bash
kongyo-scan scans inspect
```

```bash
kongyo-scan scans export --format sarif --output results.sarif
```

`inspect`、`report`、`export` はスキャンIDかその一意な先頭部分を受け取ります。省略すると、現在のディレクトリで最後に完了したスキャンを使います。エクスポート形式は `sarif`、`json`、`markdown`、`csv`、`threat-model` です。

### CIで使う

```bash
kongyo-scan scan --diff origin/main --fail-on-severity high --json > scan.json
```

- 結果は標準出力、進捗・完了メッセージ・エラーは標準エラー出力に出ます。
- `--json` を付けると、標準出力はJSON 1つだけになります。失敗時は標準エラー出力にJSONが1つ出ます。
- ターミナルがない場合、CI環境、`--non-interactive` 指定時は一切プロンプトを出しません。
- GitHub ホストの Ubuntu 24.04 ランナーでは、スキャンより前のステップで [Linux のサンドボックス](#linux-sandbox) の設定が必要です。

| 終了コード | 意味 |
| --- | --- |
| 0 | 成功。スキャンの場合は完了し、`--fail-on-severity` に該当する検出なし |
| 1 | 失敗、または `--fail-on-severity` に該当する検出あり |
| 2 | コマンドラインまたは必須入力の誤り |
| 130 | Ctrl+C による中断 |

## 設定

設定は `~/.kongyo-scan/config.json` にあります。コマンドでもUIでも変更できます。

```bash
kongyo-scan config set reasoning_effort max
```

```bash
kongyo-scan config set policy.fail_on_severity high
```

```bash
kongyo-scan config keys
```

| 設定 | 意味 |
| --- | --- |
| `providers` | フォールバック順のエンドポイント。各要素に `name`、`base_url`、`model`、`wire_api`、`api_key_env`、`headers`、`query_params`、`reasoning_effort`、`context_window`、`max_output_tokens`、`timeout_seconds`、`pricing`、`compat`、`disabled` |
| `reasoning_effort` | スキャンの推論エフォート（既定: `xhigh`） |
| `scan.mode`、`scan.scope`、`scan.max_time_minutes` | スキャンの既定値 |
| `scan.knowledge_base`、`scan.instructions_file`、`scan.validation_file`、`scan.post_scan_file`、`scan.rubric_file`、`scan.owner_suggestions` | Codex Security への入力 |
| `scan.deep.*` | ディープスキャンのワーカー数・サブエージェント数・停止条件 |
| `limits.max_cost_usd_per_scan` | スキャン1回あたりのコスト上限 |
| `policy.fail_on_severity` | スキャンを終了コード1にする深刻度 |
| `output.directory` | 成果物の出力先 |
| `codex.*` | そのまま渡すCodexのネイティブ設定（例: `codex.analytics.enabled`） |
| `python` | Codex Security が使うPythonインタープリター |
| `gateway.*` | ローカルゲートウェイのポート、クールダウン、アイドルタイムアウト、再試行回数 |

エディター向けのJSON Schemaを `schemas/config.schema.json` として同梱しています。

### リポジトリごとの設定

```bash
kongyo-scan init
```

対象範囲・モード・失敗ポリシーを書くためのひな形 `kongyo-scan.json` を作ります。このファイルは `--config kongyo-scan.json` か `KONGYO_SCAN_CONFIG` で明示したときだけ使われます。

### Codex Security の設定

Codexのネイティブ設定は `codex` 以下に書くか、1回のスキャンだけコマンドラインで指定します。

```bash
kongyo-scan scan --codex analytics.enabled=false
```

`model`、`model_provider`、`model_providers`、`model_reasoning_effort` などは kongyo-scan が管理します。代わりに `--model`、`--effort`、`providers` を使ってください。

Codex Security CLI のそのほかの機能も、設定済みのプロバイダーとスキャン状態のまま使えます。

```bash
kongyo-scan codex-security -- scans list
```

`login`、`logout`、`publish`、`feedback`、`update` は使えません。

### 保存場所

| パス | 内容 |
| --- | --- |
| `~/.kongyo-scan/config.json` | 設定 |
| `~/.kongyo-scan/state/` | Codex Security の状態（スキャン履歴と成果物） |
| `~/.kongyo-scan/state/codex-home/kongyo-scan-credentials.json` | 保存したAPIキー |
| `~/.kongyo-scan/history.jsonl` | kongyo-scan が開始したスキャンの記録（1行1件） |

別のディレクトリを使うには `KONGYO_SCAN_HOME` を設定するか `--home <DIR>` を渡します。自分の `~/.codex` は読み書きしません。

<a id="linux-sandbox"></a>

## Linux のサンドボックス

Codex Security は、スキャン中のコマンドをすべてサンドボックスの中で実行します。Linux ではそのサンドボックスが [Bubblewrap](https://github.com/containers/bubblewrap) で、ユーザー名前空間を作成できる必要があります。作成できない場合、スキャンは開始前に止まります。

```text
Can't start the scan. The command sandbox can't create user namespaces on this machine.
  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

`kongyo-scan doctor` の **Sandbox** が同じ検査を行い、何が足りないかを表示します。

### Bubblewrap をインストールする

Codex は `PATH` 上で最初に見つかった `bwrap` を使い、見つからなければ同梱のものを使います。AppArmor プロファイルを適用できるように、ディストリビューションのパッケージを入れてください。

```bash
sudo apt install bubblewrap
```

### Ubuntu 24.04: AppArmor プロファイルを追加する

Ubuntu 24.04 以降では、AppArmor プロファイルで許可されたプログラムだけが非特権ユーザー名前空間を使えます（`kernel.apparmor_restrict_unprivileged_userns=1`）。Ubuntu 24.04 には Bubblewrap 用のプロファイルがないので、`/usr/bin/bwrap` 用に追加します。`command -v bwrap` が別のパスを表示する場合は、プロファイル内のパスをそれに合わせてください。

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

AppArmor を再読み込みして適用し、確認します。

```bash
sudo systemctl reload apparmor
```

```bash
kongyo-scan doctor
```

このプロファイルは、`bwrap` 経由で起動したすべてのプログラムにユーザー名前空間の利用を許可します。Ubuntu の `apparmor-profiles` パッケージには、Bubblewrap が起動するプログラムにケーパビリティを渡さない、より厳しいプロファイルがあります。Bubblewrap のほかの使い方に支障が出ることがあるため、Ubuntu 24.04 では無効になっています。どちらも `bwrap` という名前のプロファイルを定義するので、使うのはどちらか一方だけにしてください。

```bash
sudo apt install apparmor-profiles
```

```bash
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
```

```bash
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Ubuntu 25.04 以降はこの厳しいほうのプロファイルが既定で有効なので、`bubblewrap` をインストールするだけで足ります。

### そのほかの環境

- **CI。** GitHub ホストの Ubuntu 24.04 ランナーにも同じ制限があります。スキャンより前のステップで上のコマンドを実行してください。
- **コンテナ。** コンテナランタイムは通常、コンテナ内でのユーザー名前空間の作成を禁止しています。ホストでスキャンするか、[Codex Security の Docker ガイド](https://github.com/openai/codex-security/blob/main/docker/README.md) のように、作成を許可するプロファイルをコンテナに与えてください。
- **そのほかのカーネル。** 非特権ユーザー名前空間は `kernel.unprivileged_userns_clone=0` や `user.max_user_namespaces=0` でも無効になります。`sysctl` で有効にしてください。
- **WSL。** WSL 2 は Linux と同じように動きます。WSL 1 はユーザー名前空間を作成できません。

## 開発

```bash
npm install
```

```bash
node --run check
```

`check` はフォーマット確認・リント・型検査・テストを順に実行します。ほかに `build`、`test`、`lint`、`lint:fix`、`format`、`format:fix`、設定スキーマ変更後に `schemas/config.schema.json` を再生成する `schema` があります。

## ライセンス

[MIT](./LICENSE)

kongyo-scan は Apache-2.0 でライセンスされた `@openai/codex-security` に依存しています。OpenAI との提携関係や、OpenAI による承認はありません。
