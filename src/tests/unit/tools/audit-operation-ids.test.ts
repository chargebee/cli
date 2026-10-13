import { describe, expect, it } from "bun:test";

import {
  auditDescriptorCompatibility,
  auditOperationIds,
  type AuditableResource,
  type DescriptorVersion,
} from "../../../tools/audit-operation-ids.js";

function op(sdkAction: string, v2: string, v1: string) {
  return { sdkAction, operationIdV2: v2, operationIdV1: v1 };
}

describe("auditOperationIds (spec-driven, no allowlist)", () => {
  it("reports operations that are unmapped in BOTH specs", () => {
    const resources: AuditableResource[] = [
      {
        sdkName: "customer",
        operations: [
          op("list", "list_customers", "list_customers"),
          op("addPromotionalCredits", "", ""), // unmapped in both
        ],
      },
    ];
    expect(auditOperationIds(resources).unmapped).toEqual([
      "customer.addPromotionalCredits",
    ]);
  });

  it("treats an op mapped in only one catalog spec as mapped (has a sample)", () => {
    const resources: AuditableResource[] = [
      { sdkName: "item", operations: [op("list", "list_items", "")] }, // PC2 only
      { sdkName: "plan", operations: [op("list", "", "list_plans")] }, // PC1 only
    ];
    expect(auditOperationIds(resources).unmapped).toEqual([]);
  });

  it("returns an empty list when every op is mapped (nothing to fail on)", () => {
    const resources: AuditableResource[] = [
      { sdkName: "subscription", operations: [op("create", "create_sub", "create_sub")] },
    ];
    expect(auditOperationIds(resources).unmapped).toEqual([]);
  });

  it("returns keys sorted for stable, allowlist-free reporting", () => {
    const resources: AuditableResource[] = [
      {
        sdkName: "quote",
        operations: [op("updateSignature", "", ""), op("createSignature", "", "")],
      },
      { sdkName: "order", operations: [op("ordersForInvoice", "", "")] },
    ];
    expect(auditOperationIds(resources).unmapped).toEqual([
      "order.ordersForInvoice",
      "quote.createSignature",
      "quote.updateSignature",
    ]);
  });
});

describe("auditDescriptorCompatibility", () => {
  const resources: AuditableResource[] = [
    {
      sdkName: "customer",
      operations: [
        op("list", "list_customers", "list_customers"),
        op("create", "create_a_customer", ""),
        op("unmapped", "", ""),
      ],
    },
  ];

  it("reports every mapped operation absent from the installed descriptors", () => {
    const installed = new Set(["v2-pcv1:list_customers"]);
    const hasDescriptor = (version: DescriptorVersion, operationId: string) =>
      installed.has(`${version}:${operationId}`);

    expect(auditDescriptorCompatibility(resources, hasDescriptor).missing).toEqual([
      {
        command: "customer.create",
        version: "v2-pcv2",
        operationId: "create_a_customer",
      },
      {
        command: "customer.list",
        version: "v2-pcv2",
        operationId: "list_customers",
      },
    ]);
  });

  it("ignores empty ids because that catalog has no code sample", () => {
    const hasDescriptor = () => true;
    expect(auditDescriptorCompatibility(resources, hasDescriptor).missing).toEqual([]);
  });
});
