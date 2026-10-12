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

The installer can also add the Chargebee skill for detected coding agents. To choose agents manually, decline the prompt and run:

```bash
chargebee skills add --global --agent cursor
```

Repeat `--agent` for each agent.

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/chargebee/cli/main/install.ps1 | iex
```

**npm** (requires Node.js 22+)

```bash
npm install -g @chargebee/cli
```

Verify the installation:

```bash
chargebee --version
```

Upgrade to the latest version:

```bash
chargebee update
```

Prebuilt binaries are available on the [Releases](https://github.com/chargebee/cli/releases) page.

## Configuration

Connect the CLI to your Chargebee site:

```bash
chargebee auth add
```

The CLI prompts for your site name and API key, verifies them, and saves the profile locally.

API keys are stored in macOS Keychain, Linux Secret Service, or Windows Credential Manager when available. Otherwise, they are saved in the local profile file. `auth add` reports the storage used.

You can also pass credentials directly:

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

Pass request parameters as JSON on stdin with `-`:

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

API responses are JSON, so standard tools work as expected:

```bash
chargebee customer list | jq '.list[].customer.email'
```

## JSON output

API commands print readable JSON by default. Use `--json` when you need compact output for scripts:

```bash
chargebee customer list --json | jq '.list[].customer.id'
chargebee auth status --json
```

In JSON mode, successful commands write JSON to stdout. Failures write a JSON error to stderr.

## Commands

| Command | Description |
|---|---|
| `auth` | Add API-key credentials and manage saved profiles. |
| `whoami` | Show the active site and configuration. |
| `resources` | List available API resources. |
| `<resource> <operation>` | Call a Chargebee API. |
| `docs` | Browse API documentation from the terminal. |
| `listen` | Forward webhook events to a local URL. |
| `skills` | Install the Chargebee skill for supported AI coding agents. |
| `open` | Open Chargebee Dashboard pages. |
| `feedback` | Share feedback about the CLI. |
| `alias` | Configure a shell alias for `chargebee`. |
| `update` | Update the CLI. |
| `telemetry` | Manage CLI telemetry. |

Explore commands with:

```bash
chargebee --help
chargebee <resource> --help
chargebee <resource> <operation> --help
```

For API parameters and operations:

```bash
chargebee docs <resource> <operation>
```

## Generate SDK Code

Use `--code-sample <language>` to generate runnable SDK code instead of making the API request:

```bash
chargebee customer create \
  -d email=ada@example.com \
  --code-sample python
```

Supported languages include `curl`, `python`, `nodejs`, `go`, `java`, `php`, `ruby`, and `dotnet`.

To see all supported languages:

```bash
chargebee customer create --code-sample list
```

## Webhook Forwarding

Listen for webhook events and forward them to your local application:

```bash
chargebee listen --forward-to http://localhost:3000/webhooks
```

Use `--json` for machine-readable listener output:

```bash
chargebee listen --forward-to http://localhost:3000/webhooks --json
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

Remove CLI configuration and local state:

```bash
rm -rf ~/.chargebee/cli
```

## Telemetry

The Chargebee CLI collects limited usage telemetry to improve the CLI. Opt out with:

```bash
chargebee telemetry disable
```

See [TELEMETRY.md](TELEMETRY.md) for details.

## Documentation

- [Chargebee API Documentation](https://apidocs.chargebee.com/)
- [Chargebee Documentation](https://www.chargebee.com/docs/)
- [Releases](https://github.com/chargebee/cli/releases)

Browse API documentation from the CLI:

```bash
chargebee docs
```

## Feedback

Found a bug or have a feature request?

```bash
chargebee feedback "what happened"
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on contributing to the Chargebee CLI.

## License

[MIT](LICENSE)
