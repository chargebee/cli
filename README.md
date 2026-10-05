# Chargebee CLI

Build and test your Chargebee integration from the terminal.

With the Chargebee CLI, you can:

- Work with Chargebee API resources such as customers, subscriptions, invoices, items, and more.
- Stream webhook events directly to your local application.
- Generate runnable SDK code from API commands using `--code-sample`.

## Installation

The Chargebee CLI is available for macOS, Linux, and Windows.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/chargebee/cli/main/install.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/chargebee/cli/main/install.ps1 | iex
```

On macOS, Linux, and Windows, accepting the skill installation prompt adds the skill for every detected coding agent. To choose agents yourself, answer No and then run `chargebee skills add --global --agent cursor` (repeat `--agent` for other agents).

**npm** (requires Node.js 22+)

```bash
npm install -g @chargebee/cli
```

Verify the installation:

```bash
chargebee --version
```

To upgrade to the latest version:

```bash
chargebee update
```

Prebuilt binaries are also available on the [Releases](https://github.com/chargebee/cli/releases) page.

## Configuration

Connect the CLI to your Chargebee site:

```bash
chargebee auth add
```

You'll be prompted for your site name and API key. The CLI verifies the credentials and saves the configuration locally.

API keys use macOS Keychain, Linux Secret Service (`secret-tool` and an accessible login keyring), or Windows Credential Manager (via Windows PowerShell). If unavailable, keys are saved in the local profile file; `auth add` reports the storage used.

You can also provide them directly:

```bash
chargebee auth add --site acme-test --api-key test_xxxxxxxxxxxx
```

Or use environment variables:

```bash
export CHARGEBEE_SITE=acme-test
export CHARGEBEE_API_KEY=test_xxxxxxxxxxxx
```

Create API keys from **Settings → Configure Chargebee → API Keys** in the Chargebee Dashboard.

> Write operations are blocked on live sites. Use a test site when building or testing integrations.

## Quick Example

Create a customer:

```bash
chargebee customer create \
  -d email=ada@example.com \
  -d first_name=Ada \
  -d last_name=Lovelace \
  -d auto_collection=off
```

The same parameters can be a JSON object on stdin. `-` reads that object. Nested fields are objects, and list filters use an operator key:

```bash
echo '{"email":"ada@example.com","first_name":"Ada","billing_address":{"city":"San Francisco"}}' \
  | chargebee customer create -

echo '{"id":{"is":"cbdemo_alex"}}' | chargebee customer list -
echo '{"status":{"in":["active","paused"]}}' | chargebee subscription list -
```

Retrieve the customer:

```bash
chargebee customer retrieve <customer-id>
```

API responses are written as JSON to stdout, so standard tools work as expected:

```bash
chargebee customer list | jq '.list[].customer.email'
```

## JSON output

API commands already print pretty JSON. Add the global `--json` flag for compact,
machine-readable output across API commands and built-ins:

```bash
chargebee auth status --json
chargebee --json resources
chargebee customer list --json | jq '.list[].customer.id'
chargebee customer create --code-sample curl --json | jq -r '.code'
chargebee customer list --help --json
```

For commands that finish, stdout contains one JSON value followed by a newline.
API responses retain their resource envelopes and pagination fields; SDK transport
headers are excluded. Built-ins return command-specific fields, such as
`configured`, `profiles`, `installations`, or `updated`. Empty lists remain arrays.
Profile output omits API keys. Code samples return `{ "language": "curl", "code": "…" }`;
help returns command metadata and version returns `{ "version": "…" }`.

On failure, stdout is empty and stderr contains one JSON error:

```json
{"error":{"code":"live_write_refused","message":"…","exit_code":6}}
```

`error.code` identifies the failure; `message` is explanatory text, not a value to
match in scripts. Errors may include `details` (for example, HTTP status and API
error codes). Usage errors preserve Commander's codes such as
`commander.unknownOption`. Other codes include `command_failed`, `input_required`,
`api_error`, `rate_limited`, `timeout`, `network_error`, `unconfigured`,
`catalog_refused`, and `live_write_refused`. Existing process exit codes are
unchanged. Successful commands can emit one `{ "warnings": ["…"] }` object on
stderr. No colour escapes, banners, or progress spinners are emitted in JSON mode.

`--json` disables interactive prompts, even in a terminal. Supply required inputs
explicitly; profile and skill removal still require `--yes`. Skill installation
requires `--agent`. Existing scope defaults still apply. The flag does not bypass
live-site write protection or catalog checks. Browser commands report the URL and
whether a browser launch was requested, not whether the page loaded.

### Listening with JSON

```bash
chargebee listen --forward-to http://localhost:3000/webhooks --json
```

`listen` uses JSON Lines: each stdout line is an independent JSON object, emitted
as activity occurs. Do not parse the whole session as a single JSON document.
Records have `type` and an ISO `timestamp`:

- `connecting`: connection progress (`message`).
- `ready`: the local forwarding target (`forward_to`).
- `forward_result`: event type and local HTTP response (`event_type`, `http_status`).
- `forward_failed`: event type and forwarding failure (`event_type`, `message`).
- `stopped`: graceful shutdown after pending forwards finish.

Warnings use `{ "type": "warning", "timestamp": "…", "message": "…" }` on stderr.
Terminal failures use the ordinary `error` object and a nonzero exit code; earlier
stdout records remain valid. A local non-2xx response is a `forward_result` and does
not terminate the listener. Shutdown still has a deadline; interrupted or timed-out
shutdown reports `shutdown_failed`. An OS-forced kill cannot guarantee a final record.

These records contain listener and forwarding metadata only. `--json` does not
print webhook bodies, customer fields, authorization tokens, or response bodies.

## Commands

| Command | Description |
|---|---|
| `auth` | Add API-key credentials and manage saved profiles |
| `whoami` | Show the active site and configuration |
| `resources` | List available API resources |
| `<resource> <operation>` | Call a Chargebee API |
| `docs` | Browse API documentation from the terminal |
| `listen` | Forward webhook events to a local URL |
| `skills` | Install the Chargebee skill for supported AI coding agents |
| `open` | Open Chargebee Dashboard pages |
| `feedback` | Share feedback about the CLI |
| `alias` | Configure a shell alias for `chargebee` |
| `update` | Update the CLI |
| `telemetry` | Manage CLI telemetry |

Explore commands with:

```bash
chargebee --help
chargebee <resource> --help
chargebee <resource> <operation> --help
```

Operation help identifies arguments such as `customer-id` and `subscription-id` and links to full parameter documentation. Request examples for common operations are derived from the public API specs during generation and omitted when the specs do not provide enough safe values.

For API parameters and operations:

```bash
chargebee docs <resource> <operation>
```

## Generate SDK Code

Add `--code-sample <language>` to an API command to generate runnable SDK code instead of executing the request:

```bash
chargebee customer create \
  -d email=ada@example.com \
  --code-sample python
```

Supported languages include `curl`, `python`, `nodejs`, `go`, `java`, `php`, `ruby`, and `dotnet`.

Run the following for the complete list:

```bash
chargebee customer create --code-sample list
```

Code samples check required parameters and parameter names against the generator's bundled API schema. Site-specific `cf_` custom fields are allowed. Value types and enum values are not validated locally; the API remains authoritative. These schema checks apply to code samples, not API execution.

For indexed item arrays, use Chargebee's field-first bracket notation, such as
`-d 'subscription_items[item_price_id][0]=basic-USD'` and
`-d 'subscription_items[quantity][0]=1'`. Fields with the same index describe one item.

For both API requests and code samples, each `-d` argument must contain a non-empty key followed by `=` and its value. Malformed arguments such as `-d email` fail with an error; empty values such as `-d email=` are allowed.

## Webhook Forwarding

Listen for webhook events and forward them directly to your local application:

```bash
chargebee listen --forward-to http://localhost:3000/webhooks
```

Press `Ctrl+C` to stop listening.

## Use with AI Agents

Install Chargebee skills for your coding agent:

```bash
chargebee skills add --list
chargebee skills add --agent claude-code
```

Use `--global` for user-wide installation. See `chargebee skills --help` and `chargebee skills add --help` for options.

## Uninstall

Remove the CLI using the same installation method you used.

**npm**

```bash
npm uninstall -g @chargebee/cli
```

**macOS / Linux installer**

```bash
rm "$(command -v chargebee)"
```

**Windows**

```powershell
Remove-Item (Get-Command chargebee).Source
```

To remove CLI configuration and local state:

```bash
rm -rf ~/.chargebee/cli
```

## Telemetry

The Chargebee CLI collects limited usage telemetry to help improve the CLI. You can opt out at any time with `chargebee telemetry disable`.

See [TELEMETRY.md](TELEMETRY.md) for details on what is collected and how telemetry works.

## Documentation

- [Chargebee API Documentation](https://apidocs.chargebee.com/)
- [Chargebee Documentation](https://www.chargebee.com/docs/)
- [Releases](https://github.com/chargebee/cli/releases)

You can also browse API documentation directly from the CLI:

```bash
chargebee docs
```

## Feedback

Found a bug or have a feature request? Run `chargebee feedback "what happened"`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on contributing to the Chargebee CLI.

## License

[MIT](LICENSE)
