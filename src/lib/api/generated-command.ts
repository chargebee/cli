import {
  CANONICAL_LANGUAGES,
  formatLanguageList,
  generate,
  isSupportedLanguage,
  parseDataFlags,
} from "../codesample/index.js";
import type { Command } from "commander";

import { humanLog, diagnostic, exitCommand, jsonResult } from "../output.js";
import { recordTelemetryError } from "../telemetry/error.js";
import { resolveActiveSiteName, resolveApiHost, resolveCatalogVersion } from "./sdk.js";

/**
 * Reject a path `[id]` argument that cannot travel as a single URL path
 * segment: "." / "..", or anything containing "/", "\\", whitespace, "?" or "#".
 * Every other id is handed to the SDK as-is; the SDK percent-encodes it.
 */
export function assertResourceId(id: string, command: Command): void {
  if (id === "." || id === ".." || /[\/\\\s?#]/.test(id)) {
    command.error(
      `error: invalid id "${id}": ids may not be "." or ".." or contain "/", "\\", whitespace, "?" or "#"`
    );
  }
}

export interface CodeSampleOptions {
  lang: string;
  opIdV2: string;
  opIdV1: string;
  method: string;
  uri: string;
  dataFlags: string[];
  params?: Record<string, unknown>;
  resourceId?: string;
  pathParamName?: string;
  pcVersionFlag?: string;
}

/**
 * Shared implementation for generated resource commands' `--code-sample` path.
 * Catalog gating runs in the generated action before this is called (except
 * `--code-sample list`). Write gates still skip — no Chargebee API call is made.
 */
export async function handleCodeSample(opts: CodeSampleOptions): Promise<void> {
  if (opts.lang === "list") {
    if (jsonResult({ languages: CANONICAL_LANGUAGES })) return;
    humanLog(formatLanguageList());
    return;
  }

  if (!isSupportedLanguage(opts.lang)) {
    diagnostic(`Unsupported code sample language: ${opts.lang}`);
    diagnostic(`Supported languages: ${CANONICAL_LANGUAGES.join(", ")}`);
    diagnostic("Run any resource operation with: --code-sample list");
    recordTelemetryError("usage");
    exitCommand(1);
  }

  let pcVersion =
    opts.pcVersionFlag === "v1" || opts.pcVersionFlag === "v2"
      ? opts.pcVersionFlag
      : undefined;
  if (!pcVersion) pcVersion = (await resolveCatalogVersion()) ?? "v2";

  const operationId =
    pcVersion === "v1"
      ? opts.opIdV1 || opts.opIdV2
      : opts.opIdV2 || opts.opIdV1;
  if (!operationId) {
    diagnostic("Code sample generation is not available for this operation.");
    recordTelemetryError("usage");
    exitCommand(1);
  }

  const site = (await resolveActiveSiteName()) ?? "your-site";
  const host = await resolveApiHost();
  const params = opts.params ?? parseDataFlags(opts.dataFlags);
  const code = await generate({
    operationId,
    language: opts.lang,
    params,
    resourceId: opts.resourceId,
    pathParamName: opts.pathParamName,
    site,
    method: opts.method,
    uri: opts.uri,
    pcVersion,
    hostSuffix: host.suffix,
    protocol: host.protocol,
  });
  if (jsonResult({ language: opts.lang, code })) return;
  humanLog(code);
}
