/**
 * Spec-driven operationId coverage report used by the code generator.
 *
 * An operation whose operationId is empty in BOTH the PC1 and PC2 specs simply
 * has no code sample (the CLI reports that gracefully at runtime). That is a
 * fact about the published OpenAPI specs, not a generator error — so we derive
 * the "unmapped" set directly from the spec join instead of maintaining a
 * hardcoded allowlist in CLI code (see issue #44). The set self-heals when the
 * specs add or drop an operation, with no code change required.
 */

/** Minimal shape needed to audit an operation's spec coverage. */
export interface AuditableOperation {
  sdkAction: string;
  operationIdV2: string;
  operationIdV1: string;
}

/** Minimal shape needed to audit a resource's operations. */
export interface AuditableResource {
  sdkName: string;
  operations: AuditableOperation[];
}

export type DescriptorVersion = "v2-pcv1" | "v2-pcv2";

export interface MissingDescriptor {
  command: string;
  version: DescriptorVersion;
  operationId: string;
}

/**
 * Return the sorted list of `<sdkName>.<sdkAction>` keys whose operationId is
 * absent from both specs. Purely informational: callers must not treat a
 * non-empty result as a failure.
 */
export function auditOperationIds(resources: AuditableResource[]): {
  unmapped: string[];
} {
  const unmapped: string[] = [];
  for (const r of resources) {
    for (const op of r.operations) {
      if (!op.operationIdV2 && !op.operationIdV1) {
        unmapped.push(`${r.sdkName}.${op.sdkAction}`);
      }
    }
  }
  unmapped.sort();
  return { unmapped };
}

/**
 * Verify that every non-empty operationId generated from the public specs is
 * present in the installed code-sample-generator package. An absent id would
 * produce a CLI command whose `--code-sample` path fails at runtime.
 */
export function auditDescriptorCompatibility(
  resources: AuditableResource[],
  hasDescriptor: (version: DescriptorVersion, operationId: string) => boolean,
): { missing: MissingDescriptor[] } {
  const missing: MissingDescriptor[] = [];

  for (const resource of resources) {
    for (const operation of resource.operations) {
      const command = `${resource.sdkName}.${operation.sdkAction}`;
      const ids: Array<[DescriptorVersion, string]> = [
        ["v2-pcv1", operation.operationIdV1],
        ["v2-pcv2", operation.operationIdV2],
      ];

      for (const [version, operationId] of ids) {
        if (operationId && !hasDescriptor(version, operationId)) {
          missing.push({ command, version, operationId });
        }
      }
    }
  }

  missing.sort((a, b) =>
    `${a.command}:${a.version}:${a.operationId}`.localeCompare(
      `${b.command}:${b.version}:${b.operationId}`,
    ),
  );
  return { missing };
}
