# Contributing

Thanks for helping improve the Chargebee CLI.

The CLI is built with [Bun](https://bun.sh) and TypeScript. Use the Bun version specified in `.bun-version`. Node.js 22.12+ is also required to test the npm build.

## Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/chargebee/cli.git
cd cli
bun install
```

Verify your setup:

```bash
bun test
bun run typecheck
```

## Development

Common development commands:

```bash
bun run dev customer list   # Run the CLI with hot reload
bun test --watch            # Re-run tests on changes
bun run build               # Build a standalone binary
bun run build:npm           # Build the Node.js-compatible npm package
```

All development tasks are defined as scripts in `package.json`.

## Repository Structure

```text
src/
├── commands/       CLI commands
├── lib/            Core CLI functionality
├── tools/          Code generation and development utilities
└── tests/
    ├── unit/        Unit tests
    ├── integration/ CLI integration tests
    ├── cli/         Shared native/npm process tests
    ├── npm/         npm-specific process tests
    ├── native/      Opt-in real OS credential tests
    └── live/        Opt-in real-service integration tests
```

Commands under `src/commands/generated/` are generated automatically. See [Code Generation](#code-generation) before modifying generated commands.

## Testing

Run source tests and the isolated CLI process suite:

```bash
bun run test
```

Use `bun run test:source`, `bun run test:cli`, `bun run test:npm`, `bun run test:os`, or `bun run test:live` for a specific layer. Source tests need no Chargebee credentials. Artifact tests execute the compiled binary or npm bundle on all three OSes in CI. Native credential and live-service tests are opt-in.

See [the test matrix and fixture requirements](src/tests/README.md) for runner assignments, US site secrets, credential-session setup, cleanup, and current coverage limits. Direct `bun test` discovers all suites, with live scenarios guarded by their environment requirements.

### Coverage

CI requires at least **95% function and line coverage per file**.

Run the same coverage check locally:

```bash
bun run test:coverage 2>&1 | tee coverage.txt
bun run coverage:gate coverage.txt
```

Do not configure Bun's built-in coverage threshold in `bunfig.toml`. Due to [oven-sh/bun#17028](https://github.com/oven-sh/bun/issues/17028), coverage thresholds are enforced separately by `coverage-gate.ts`.

## Code Generation

Commands under `src/commands/generated/` are generated from the Chargebee Node SDK endpoint registry and public OpenAPI specifications. **Do not edit generated files manually.**

After changing the generator or updating its inputs, run:

```bash
bun run generate --refresh
```

`--refresh` fetches the current public specs. Without it, `bun run generate` reuses `.cache/specs/` and can miss the drift CI reports. Commit the generated changes along with your PR; CI checks for generated-code drift.

## Toolchain

CI and release workflows use the Bun version specified in `.bun-version`.

Install the same version locally:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"
```

## Making Changes

1. Create a branch from `main`.
2. Keep changes focused and add tests where appropriate.
3. Run `bun test` and `bun run typecheck`.
4. Verify coverage when adding or modifying tested code.
5. Update documentation or `CHANGELOG.md` when behavior changes.
6. Never commit API keys, credentials, or other secrets.

Versions are managed automatically by Release Please. **Do not update package versions manually.**

Stable releases publish to npm `latest`; prereleases publish only to `beta`. Review the final Conventional Commit message and generated release notes before merging. Breaking-change markers request a major release.

### Release installation checks

Release-please PRs use reduced checks only when all three release files change:
`package.json` (version only), `.release-please-manifest.json` (matching root
version only), and `CHANGELOG.md` (including the new version). The classifier
compares the PR merge commit with its exact base and requires successful CI
and install-channel workflows on that base. Unexpected changes, failed checks,
or unavailable validation information select full CI.

Eligible PRs retain source tests, coverage, typecheck, secret scanning, and one
Linux job that builds and installs both native and npm artifacts and checks
their release version. Code generation, the full OS/Node matrices, and the five
cross-compilation jobs are skipped. Main pushes always run full checks.

Release automation waits for both `CI` and `Install-channel smoke` to succeed
on the exact main commit before running Release Please. Failed, cancelled,
missing, or inaccessible checks cannot authorize a release. After fixing a
failed main check and rerunning it successfully, rerun the blocked Release
workflow. The gate also delays release-PR maintenance until main is green.

The release workflow builds the npm bundle before publishing and checks that
the packing list contains a nonempty `README.md` and CLI entry point. It uses
the same npm authentication configuration for publishing and registry checks.

After publishing, CI uses `npm cache add` to resolve and download the exact
version before updating `latest` or installing it. This checks the installation
metadata and tarball without executing lifecycle scripts. It then inspects the
published tarball with `npm pack --dry-run --ignore-scripts` and requires a
nonempty README and CLI entry point. Version availability checks retry up to
60 times, 10 seconds apart, with a 20-second timeout per npm command.
Authentication failures stop immediately; a persistent 404 may indicate
missing access to a private package. Installation and its
lifecycle scripts run only once after the version is available.

The separate `npm-readme-metadata` job checks npm's README index up to six
times. Indexing can lag a valid publication, so this job reports a warning and
job summary if metadata cannot be verified; it does not block installation
tests. Its logs distinguish missing metadata from authentication and registry
errors. The published tarball contents remain a required check.

To recheck indexing later, run
`node scripts/wait-for-npm-release.mjs @chargebee/cli@<version> readme`
with npm authenticated. If the metadata remains empty, contact npm support.
This check does not verify npm's website rendering; if it passes but npmjs.com
still shows no README, investigate npm's website/cache. A failed post-publish
check does not undo publication; do not rerun a successful publish step for
the same version.

## Pull Requests

Before opening a pull request, make sure:

- Tests and type checks pass.
- Generated code is up to date.
- New behavior is covered by tests where appropriate.
- User-facing changes include relevant documentation updates.
- The PR clearly explains what changed and why.

## Security

Do not open public issues for security vulnerabilities.

Follow [SECURITY.md](SECURITY.md) for instructions on reporting security issues privately.
