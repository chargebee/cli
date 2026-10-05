# Chargebee CLI — Agent Guide

Chargebee CLI is a single-package Bun/TypeScript CLI. The repository root is the package root.

Use this file as the primary guidance when modifying the repository. See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup and workflow.

## Build and Test

Use the Bun version defined in `.bun-version`.

```bash
bun install
bun run dev customer list
bun test
bun run typecheck
bun run build
bun run build:npm
```

All repository tasks are defined in `package.json`. Prefer these scripts over duplicating their underlying commands.

Before completing a change, run the tests and type checks relevant to the files you modified.

## Repository Structure

```text
src/
├── index.ts               CLI entry point
├── program.ts             Commander program and command registration
├── commands/              Built-in CLI commands
│   └── generated/         Generated API resource commands
├── lib/                   Core CLI functionality
├── tools/                 Build and code-generation tooling
└── tests/
    ├── unit/              Unit tests
    ├── integration/       Isolated CLI tests
    ├── cli/               Native/npm CLI process tests
    ├── npm/               npm-specific process tests
    ├── native/            Opt-in real OS credential tests
    └── live/              Tests against Chargebee services
```

Key areas under `src/lib/`:

- `api/` — SDK client, authentication, output, and safety gates
- `config/` — profiles and CLI configuration
- `codesample/` — SDK code generation
- `docs/` — API documentation client
- `tunnel/` — webhook forwarding
- `telemetry/` — CLI telemetry
- `skills/` — Chargebee skill and installer
- `update/` — CLI self-update

User configuration belongs under `~/.chargebee/cli/`, never inside the repository.

## Code Generation

API commands under `src/commands/generated/` are generated from the Chargebee Node.js SDK endpoint registry and public OpenAPI specifications.

**Never edit generated command files manually.**

After changing the generator or its inputs:

```bash
bun run generate --refresh
```

`--refresh` fetches the current public specs. Without it, generation reuses `.cache/specs/`. Commit generated changes with the source change. CI checks for generated-code drift.

## Architecture

The CLI uses Commander.js for command parsing.

```text
src/index.ts
    ↓
buildProgram() in src/program.ts
    ↓
built-in + generated commands
    ↓
Chargebee SDK
    ↓
Chargebee API
```

`buildProgram()` is separate from `index.ts` so integration tests can execute the CLI without process-level side effects.

Generated API commands use the Chargebee Node.js SDK. Keep authentication, retries, and API communication through the SDK unless a feature explicitly requires otherwise.

### Authentication

Use `chargebee auth add` for API-key setup and `auth list/status/switch/rename/remove` for saved profiles. `auth login/logout` are reserved for future OAuth support; top-level `login` only prints API-key setup guidance.

Authentication is resolved in this order:

```text
--use-profile
    ↓
CHARGEBEE_SITE + CHARGEBEE_API_KEY
    ↓
active profile
    ↓
legacy configuration
```

`CHARGEBEE_SITE` and `CHARGEBEE_API_KEY` must be provided together.

Do not introduce additional credential storage paths without an explicit requirement.

### Safety Gates

Generated API commands enforce two protections:

- **Write gate:** Write operations are blocked on live sites.
- **Catalog gate:** Product Catalog-specific operations are blocked when they do not match the configured site's catalog version.

For `--code-sample`, the **write gate does not apply** because no API request is executed. The **catalog gate still applies** so generated code matches the site's Product Catalog version.

Preserve this distinction when changing API execution or code-sample generation.

## Testing

Tests belong under:

```text
src/tests/unit/
src/tests/integration/
src/tests/cli/
src/tests/npm/
src/tests/native/
src/tests/live/
```

Do not colocate `*.test.ts` files under `src/lib/`, `src/tools/`, or `src/commands/`.

- **Unit:** isolated functions and modules; no Commander or network.
- **Integration:** real Commander program with test doubles; no Chargebee credentials.
- **CLI:** shared subprocess scenarios for native and npm artifacts on Linux, macOS, and Windows.
- **npm:** artifact-specific behavior under supported Node versions on all three OSes.
- **Native:** real OS credential adapters in explicitly provisioned disposable sessions.
- **Live:** compiled CLI against US test fixtures and live-site read/write-refusal checks; opt-in only. See [src/tests/README.md](src/tests/README.md).

Run live tests with:

```bash
bun run test:live
```

Never permit successful writes on live Chargebee sites in automated tests. Live-site customer-create tests must assert the CLI write gate refuses the operation; use a dedicated validation site and read-only key. Successful remote writes are limited to customer creation and cleanup deletion on test sites.

Shared test helpers belong in `src/lib/test-support/` and must never be imported by production entry points or commands.

### Coverage

CI requires **95% function and line coverage per file**.

```bash
bun run test:coverage 2>&1 | tee coverage.txt
bun run coverage:gate coverage.txt
```

Do not configure Bun coverage thresholds in `bunfig.toml`; `coverage-gate.ts` handles enforcement.

## Code Conventions

When modifying the repository:

- Follow existing patterns before introducing new abstractions.
- Keep commands thin; reusable behavior belongs under `src/lib/`.
- Use the Chargebee SDK for API operations instead of duplicating HTTP clients.
- Keep stdout for command output and stderr for errors and diagnostics.
- Preserve consistent behavior across generated and built-in commands.
- Use existing `package.json` scripts instead of introducing new task runners.
- Never commit credentials, tokens, customer data, or other secrets.

## Making Changes

Keep changes focused. Avoid mixing structural refactors with behavioral changes unless they are required together.

For user-facing changes:

1. Add or update tests.
2. Update relevant documentation.
3. Regenerate generated code when required.
4. Run relevant tests and type checks.
5. Verify safety gates and credential handling remain intact.

Versions are managed by release automation. **Do not update package versions manually.**

## Agent Rules

Before modifying an unfamiliar area, inspect its implementation and tests rather than assuming patterns from other CLIs.

Prefer existing repository abstractions over introducing parallel implementations.

Do not:

- hand-edit generated API commands
- bypass write or catalog gates
- expose or log credentials
- add network dependencies to unit or integration tests
- move user configuration into the repository
- modify release versions manually
- claim tests or builds passed unless you ran them successfully

If a requested change conflicts with an invariant documented here, surface the conflict rather than silently bypassing it.

## Public Repository

Treat everything committed or pushed to this repository as public.

Do not include customer data, credentials, internal conversations, private incident details, or other non-public Chargebee information in code, tests, fixtures, comments, commits, or PR descriptions.

## Security

Follow [SECURITY.md](SECURITY.md) for security-related changes and vulnerability reporting.