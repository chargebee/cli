import type { Command } from "commander";
import { diagnostic, exitCommand, jsonResult } from "../lib/output.js";
import { setCommandGroup } from "./help.js";
import {
  fetchOperation,
  fetchResource,
  listOperations,
  listResources,
  stripControlChars,
} from "../lib/docs/index.js";

const OFFLINE_MSG =
  "Could not reach apidocs.chargebee.com and no cached copy is available. Check your network and try again.";

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command("docs [resource] [operation]")
    .description("Browse live API documentation for all resources and operations")
    .action(async (resource?: string, operation?: string) => {
      if (!resource) {
        const resources = await listResources();
        if (resources.length === 0) {
          diagnostic(OFFLINE_MSG);
          exitCommand(1);
        }
        if (jsonResult({ resources })) return;
        process.stdout.write(formatResourceList(resources));
        return;
      }

      if (!operation) {
        const res = await fetchResource(resource);
        if (!res.ok) {
          if (res.reason === "offline") diagnostic(OFFLINE_MSG);
          else
            diagnostic(
              `Unknown resource: "${resource}". Run 'chargebee docs' to see all resources.`
            );
          exitCommand(1);
        } else {
          const ops = await listOperations(resource);
          if (jsonResult({ resource, body: stripControlChars(res.body).trimEnd(), operations: ops, source: res.url })) return;
          process.stdout.write(stripControlChars(res.body).trimEnd());
          if (ops.length > 0) {
            process.stdout.write(`\n\nOperations (${ops.length}):\n`);
            for (const op of ops) process.stdout.write(`  ${op}\n`);
            process.stdout.write(`\nUsage: chargebee docs ${resource} <operation>\n`);
          }
          process.stdout.write(`\nSource: ${res.url}\n`);
        }
        return;
      }

      const op = await fetchOperation(resource, operation);
      if (!op.ok) {
        if (op.reason === "offline") {
          diagnostic(OFFLINE_MSG);
        } else if (op.operations) {
          diagnostic(
            `Unknown operation "${operation}" for resource "${resource}". Available: ${formatOpHint(op.operations)}`
          );
        } else {
          diagnostic(
            `Unknown resource: "${resource}". Run 'chargebee docs' to see all resources.`
          );
        }
        exitCommand(1);
      } else {
        if (jsonResult({ resource, operation, body: stripControlChars(op.body).trimEnd(), source: op.url })) return;
        process.stdout.write(stripControlChars(op.body).trimEnd());
        process.stdout.write(`\n\nSource: ${op.url}\n`);
      }
    });

  setCommandGroup(docs, "core");
}

function formatResourceList(resources: string[]): string {
  const lines = ["Available API resources:\n"];
  for (const r of resources) lines.push(`  ${r}`);
  lines.push(`\n  ${resources.length} resources total`);
  lines.push("\nUsage: chargebee docs <resource> [operation]");
  return `${lines.join("\n")}\n`;
}

function formatOpHint(ops: string[]): string {
  return ops.length > 10
    ? `${ops.slice(0, 10).join(", ")}, ... (${ops.length} total)`
    : ops.join(", ");
}
