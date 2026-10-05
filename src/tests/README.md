# Test execution matrix

| Suite | Command / workflow | Execution | OS coverage | External prerequisites |
|---|---|---|---|---|
| Source | `bun run test:source` | Unit functions and in-process CLI with test doubles | Ubuntu | None |
| Source quality | `bun run test:coverage`, typecheck, codegen drift | Source checks reusable workflow | Ubuntu | Public generation specs |
| CLI artifact | `bun run test:cli` | Native binary or npm bundle selected by environment | Linux, macOS, Windows; npm Node 22/24 | None |
| npm-specific behavior | `bun run test:npm` | Shared CLI suite plus detached telemetry-child tests | Linux, macOS, Windows × Node 22/24 | None |
| Native credentials | `bun run test:os` | Actual OS credential adapters | Linux, macOS, Windows | Provisioned disposable credential session |
| Installation | Install-channel smoke workflow | Installs this commit's artifacts and runs the installed CLI | Supported OS/channel combinations; npm Node 22/24 | Package tooling |
| Live API | `bun run test:live` | Compiled native CLI | Linux, macOS, Windows, serialized | US site fixtures, read-only live-site key, public US tunnel |

CI and installation checks run in full on all PRs and pushes to main. Release automation waits for both workflows to succeed on its exact main commit. See [release installation checks](../../CONTRIBUTING.md#release-installation-checks).

Live tests run daily at 06:00 UTC or by manual dispatch, after source quality checks for the same commit. Only source tests contribute to the 95% per-file coverage gate; coverage of the Bun test process does not measure separately compiled CLI processes.

`bun run test` runs source and CLI suites. Direct `bun test` still discovers all folders; live and real-vault tests remain guarded. Prefer the explicit scripts in automation. CI requires `CB_REQUIRE_BINARY=1` so artifact tests cannot accidentally fall back to source execution.

## Artifact scenarios

`src/tests/cli/` runs the same assertions against native executables and npm bundles. It checks every registered command and public subcommand's help, non-TTY `auth add` behavior, errors and exit codes, skills lifecycle in isolated project/global directories, resource discovery, telemetry preferences, and write/catalog refusals. The command inventory requires a scenario assignment or an explicit exception for every builtin.

Help coverage is not real API execution coverage. Remote mutations are restricted to customer creation and deletion for cleanup on test sites. Other generated operations have source-level regression tests and artifact help checks; they are not all executed remotely. Browser opening, feedback submission, and shell mutation are intentionally excluded from remote live scenarios. Self-update has source tests but still needs a disposable previous-release fixture for an artifact-to-artifact upgrade scenario.

Example native execution:

```bash
bun run build --outfile=dist/chargebee-cli
CHARGEBEE_CLI_BINARY=dist/chargebee-cli CB_REQUIRE_BINARY=1 bun run test:cli
```

For npm, build with `bun run build:npm`, set `CHARGEBEE_CLI_BINARY=dist/index.js` and `CHARGEBEE_CLI_NODE=node`.

## US live fixtures

Configure these repository secrets before running the trusted live workflow:

- `CB_TEST_SITE_1`, `CB_TEST_KEY_1`: a US test site.
- `CB_TEST_SITE_2`, `CB_TEST_KEY_2`: a second distinct US test site.
- `CB_LIVE_SITE`, `CB_LIVE_KEY`: a dedicated US live-mode validation site with a read-only key.

Both sites may use PC2. Catalog assertions follow the version and response schema detected during `auth add`; PC1-only, PC2-only, and dual-mode sites are supported. Missing real PC1-only or PC2-only fixture coverage is explicitly reported, without blocking the other scenarios.

Both test-site names must end in `-test` and identify distinct sites. The test keys need customer create/read/delete and catalog read permissions plus access needed by `auth add` and webhook tunnelling. The workflow selects US; fixture administrators must provision sites in that region. Missing fixtures or native-storage setup fail required runs (`CB_REQUIRE_LIVE=1`). Do not put real credentials in command arguments or checked-in fixtures.

Live scenarios include:

- Existing environment authentication, profile selection and switching tests.
- `auth add` with real OS storage, no inline secret in profile JSON, cross-process authenticated reads, rename, remove, and independent credential deletion verification.
- Catalog-compatible reads and rejection of incompatible commands (including code samples), selected from each fixture’s detected catalog. Dual-mode fixtures permit both resource families.
- Customer creation through JSON stdin, retrieve, filtered listing, and verified deletion on each test site.
- LIVE customer read and attempted create that must fail with the CLI write-gate exit code/message. API authorization failure is not a passing gate test. No successful live-site write is expected or permitted.
- Documentation resource/operation discovery and errors; customer code generation in all eight supported languages, with JavaScript syntax checking. Other language compilation/execution remains outside this suite.
- Tunnel readiness followed by customer creation and receipt of its matching `customer_created` event at a local receiver.

The CLI configures production AppSync endpoints for US, EU, and AU; the live suite currently exercises US test sites only. Configuring an endpoint does not verify deployment connectivity or event forwarding; the live tunnel scenario checks those with the fixture credentials.

## Isolation and cleanup

The credential-session action provisions a temporary unlocked macOS keychain or Linux D-Bus/keyring session. Windows uses unique disposable entries in the runner's Credential Manager. Real-store tests require `CHARGEBEE_TEST_OS_KEYCHAIN=1`. Live `auth add` tests also set `CHARGEBEE_CLI_KEYCHAIN=1` to override the default file store for their temporary `CHARGEBEE_CONFIG_DIR`.

Customer fixture IDs are unique per test and OS, allocated before creation. Teardown attempts deletion even after a creation timeout, retries failures, polls for a deleted marker or not-found response (permanent removal is asynchronous), and fails with the synthetic fixture ID if manual cleanup is needed. No unrelated customers are deleted. A forced runner termination can prevent teardown; inspect failed run diagnostics for fixture IDs. Cleanup deletion is the sole additional allowed API write.

Live OS jobs run sequentially because tunnel sessions share a fixture site. Teardown closes the local receiver/tunnel and removes temporary profile data and credential entries. Local live runs require explicit fixture credentials; avoid running simultaneously against the same tunnel site.
