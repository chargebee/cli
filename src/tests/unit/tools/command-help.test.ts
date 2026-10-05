import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { descriptionLine, operationHelp, specArgument, specExample } from "../../../tools/command-help.js";
import { parseDataFlags } from "../../../lib/codesample/index.js";

describe("spec-derived argument help", () => {
  it("uses the endpoint's customer argument for a subscription operation", () => {
    const spec = { components: {
      parameters: { customer: { name: "customer-id", in: "path", required: true } },
      schemas: { Customer: { properties: { id: { description: "The unique identifier of the `customer` resource. More details." } } } },
    } };
    expect(specArgument(spec, "/customers/{customer-id}/subscription_for_items", {}, {
      parameters: [{ $ref: "#/components/parameters/customer" }],
    })).toEqual({ name: "customer-id", description: "The unique identifier of the customer resource." });
  });

  it("prefers operation descriptions over shared path parameters and resource IDs", () => {
    expect(specArgument({}, "/customers/{customer-id}", {
      parameters: [{ name: "customer-id", in: "path", description: "Shared description." }],
    }, {
      parameters: [{ name: "customer-id", in: "path", description: "Customer to update. More details." }],
    })).toEqual({ name: "customer-id", description: "Customer to update." });
  });

  it("resolves escaped local references and their description overrides", () => {
    const spec = { components: { parameters: {
      "customer/id~": { name: "customer-id", in: "path", description: "Original." },
    } } };
    expect(specArgument(spec, "/customers/{customer-id}", {
      parameters: [{ $ref: "#/components/parameters/customer~1id~0", description: "Override." }],
    }, {})?.description).toBe("Override.");
  });

  it("uses the parameter schema description when available", () => {
    const spec = { components: { schemas: { Identifier: { description: "Invoice to retrieve." } } } };
    expect(specArgument(spec, "/invoices/{invoice-id}", {}, {
      parameters: [{ name: "invoice-id", in: "path", schema: { $ref: "#/components/schemas/Identifier" } }],
    })?.description).toBe("Invoice to retrieve.");
  });

  it("resolves resource schemas and ID schemas by the argument's resource name", () => {
    const spec = { components: { schemas: {
      ItemPrice: { $ref: "#/components/schemas/Price" },
      Price: { properties: { id: { $ref: "#/components/schemas/Identifier" } } },
      Identifier: { description: "The `item_price` identifier." },
    } } };
    expect(specArgument(spec, "/item_prices/{item_price-id}", {}, {})?.description)
      .toBe("The item_price identifier.");
  });

  it("falls back to a meaningful identifier label when descriptions are absent", () => {
    expect(specArgument({}, "/invoices/{invoice-id}", {}, {}))
      .toEqual({ name: "invoice-id", description: "Invoice identifier." });
    expect(specArgument({}, "/resources/{id}", {}, {})?.description).toBe("Resource identifier.");
    expect(specArgument({}, "/resources", {}, {})).toBeUndefined();
  });

  it("handles missing, external, and cyclic references without fetching or hanging", () => {
    const spec = { components: { parameters: { loop: { $ref: "#/components/parameters/loop" } } } };
    expect(specArgument(spec, "/customers/{customer-id}", {}, { parameters: [
      { $ref: "#/components/parameters/loop" },
      { $ref: "#/missing" },
      { $ref: "https://example.com/parameter.json" },
    ] })?.description).toBe("Customer identifier.");
  });

  it("cleans markup, multiline text, and control characters for terminal help", () => {
    expect(descriptionLine("**The** [customer](/customers) `id`\nfor <b>this</b> _request_.\nMore details."))
      .toBe("The customer id for this request.");
    expect(descriptionLine("An\u0000identifier")).toBe("An identifier");
    expect(descriptionLine(undefined)).toBe("");
  });
});

describe("operation help examples", () => {
  it("renders generated arguments and quotes JSON as one shell argument", () => {
    const help = operationHelp("subscription", "create-with-items", true, ["<customer-id>", "-d", 'subscription_items=[{"item_price_id":"basic-USD","quantity":1}]']);
    expect(help).toContain("chargebee subscription create-with-items '<customer-id>' \\\n");
    expect(help).toContain(`-d 'subscription_items=[{"item_price_id":"basic-USD","quantity":1}]'`);
    expect(help).toContain("Add --code-sample python");
    expect(help).toContain("chargebee docs subscription create-with-items");
    expect(help).not.toMatch(/PC1|PC2|catalog|may be omitted|Replace cust_123/);
  });

  it("keeps a docs pointer for operations without curated examples", () => {
    expect(operationHelp("customer", "add-contact", false)).toBe(
      "\n\x1b[1mDOCUMENTATION\x1b[0m\n  chargebee docs customer add-contact\n",
    );
  });

  it("does not advertise unavailable code generation", () => {
    const help = operationHelp("customer", "retrieve", false, ["<customer-id>"]);
    expect(help).toContain("chargebee customer retrieve '<customer-id>'");
    expect(help).not.toContain("Generate SDK code");
  });

  it("escapes apostrophes and omits terminal control characters", () => {
    expect(operationHelp("customer", "create", false, ["-d", "name=O'Connor"])).toContain("'name=O'\\''Connor'");
    expect(operationHelp("customer", "create", false, ["-d", "name=bad\nvalue"])).not.toContain("EXAMPLE");
  });
});

describe("spec-derived examples", () => {
  const base = (schema: Record<string, unknown>, operation: Record<string, unknown> = {}) => specExample(
    {}, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": { schema } } }, ...operation,
    },
  );

  it("uses a documented request example when valid, including SDK array-of-object JSON", () => {
    const result = specExample({ components: { schemas: {} } }, "subscription", "create-with-items", "/subscriptions", {}, {
      requestBody: { content: { "application/json": {
        schema: { type: "object", required: ["subscription_items"], properties: {
          subscription_items: { type: "array", items: { type: "object", required: ["item_price_id"], properties: { item_price_id: { type: "string" }, quantity: { type: "integer" } } } },
        } },
        example: { subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }] },
      } } },
    });
    expect(result).toEqual(["-d", 'subscription_items=[{"item_price_id":"basic-USD","quantity":1}]']);
  });

  it("derives only required fields from concrete schema values and follows refs", () => {
    const spec = { components: { schemas: {
      Create: { type: "object", required: ["email", "active"], properties: {
        email: { $ref: "#/components/schemas/Email" }, active: { type: "boolean", default: true }, optional: { type: "string", example: "skip" },
      } },
      Email: { type: "string", example: "ada@example.com", format: "email" },
    } } };
    expect(specExample(spec, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Create" } } } },
    })).toEqual(["-d", "email=ada@example.com", "-d", "active=true"]);
  });

  it("omits when required values are missing, invalid, composed, or contain unknown fields", () => {
    expect(base({ type: "object", required: ["id"], properties: { id: { type: "string" } } })).toBeUndefined();
    expect(base({ type: "object", required: ["id"], properties: { id: { type: "string", example: "bad\nvalue" } } })).toBeUndefined();
    const unknownField = specExample({}, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": {
        schema: { type: "object", additionalProperties: true, properties: { id: { type: "string" } }, example: { id: "ok", typo: true } },
      } } },
    });
    expect(unknownField).toBeUndefined();
    expect(specExample({}, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: {
        id: { type: "string" }, name: { type: "string" },
      } }, example: { id: "cust_example" } } } },
    })).toBeUndefined();
    expect(specExample({}, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } }, example: { removed: "value" } } } } },
    })).toBeUndefined();
    expect(base({ type: "object", required: ["id"], properties: { id: { oneOf: [{ type: "string" }], example: "ok" } } })).toBeUndefined();
  });

  it("uses query required fields and the first safe optional scalar without naming limit", () => {
    expect(specExample({}, "customer", "list", "/customers", {}, { parameters: [
      { name: "status", in: "query", required: true, schema: { type: "string", enum: ["active"] } },
      { name: "sort_by", in: "query", schema: { type: "string", example: "created_at" } },
      { name: "other", in: "query", schema: { type: "integer", example: 2 } },
    ] })).toEqual(["-d", "status=active", "-d", "sort_by=created_at"]);
  });

  it("lets operation query parameters override shared path parameters", () => {
    expect(specExample({}, "customer", "list", "/customers", {
      parameters: [{ name: "status", in: "query", required: true, schema: { type: "string" } }],
    }, { parameters: [{ name: "status", in: "query", schema: { type: "string", example: "active" } }] }))
      .toEqual(["-d", "status=active"]);
  });

  it("rejects complex enums, unresolved refs with siblings, and form column arrays", () => {
    expect(specExample({}, "subscription", "create-with-items", "/subscriptions", {}, {
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["items"], properties: {
        items: { type: "array", items: { type: "string" }, enum: [["x"]], example: ["x"] },
      } }, example: { items: ["x"] } } } },
    })).toBeUndefined();
    expect(specExample({}, "customer", "create", "/customers", {}, {
      requestBody: { content: { "application/json": { schema: { type: "object", properties: {
        id: { $ref: "#/components/schemas/missing", type: "string", example: "cust_x" },
      } }, example: { id: "cust_x" } } } },
    })).toBeUndefined();
    expect(specExample({}, "subscription", "create-with-items", "/subscriptions", {}, {
      requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["subscription_items"], properties: {
        subscription_items: { type: "object", properties: { item_price_id: { type: "array", items: { type: "string" } } } },
      } }, example: { subscription_items: { item_price_id: ["basic-USD"] } } } } },
    })).toBeUndefined();
  });

  it("fails closed on unresolved parameter and request-body refs with sibling fields", () => {
    expect(specExample({}, "customer", "retrieve", "/customers/{customer-id}", {}, { parameters: [
      { $ref: "#/components/parameters/missing", in: "path", name: "customer-id", schema: { type: "string" } },
    ] })).toBeUndefined();
    expect(specExample({}, "customer", "create", "/customers", {}, {
      requestBody: { $ref: "#/components/requestBodies/missing", content: { "application/json": {
        schema: { type: "object", properties: { id: { type: "string" } } }, example: { id: "cust_x" },
      } } },
    })).toBeUndefined();
  });

  it("tracks schema drift when an example field is renamed and newly required", () => {
    const requestSchema: Record<string, any> = {
      type: "object", required: ["id"],
      properties: { id: { type: "string" }, name: { type: "string" } },
      example: { id: "cust_example" },
    };
    const operation = { requestBody: { content: { "application/json": { schema: requestSchema } } } };
    expect(specExample({}, "customer", "create", "/customers", {}, operation)).toEqual(["-d", "id=cust_example"]);
    requestSchema.required = ["customer_id", "name"];
    requestSchema.properties = { customer_id: { type: "string" }, name: { type: "string" } };
    expect(specExample({}, "customer", "create", "/customers", {}, operation)).toBeUndefined();
    requestSchema.example = { customer_id: "cust_example", name: "Ada" };
    expect(specExample({}, "customer", "create", "/customers", {}, operation)).toEqual([
      "-d", "customer_id=cust_example", "-d", "name=Ada",
    ]);
  });

  it("uses a validated path example or a placeholder and rejects option-like values", () => {
    expect(specExample({}, "customer", "retrieve", "/customers/{customer-id}", {}, {})).toBeUndefined();
    expect(specExample({}, "customer", "retrieve", "/customers/{customer-id}", {}, { parameters: [
      { name: "customer-id", in: "path", schema: { type: "string" } },
    ] })).toEqual(["<customer-id>"]);
    expect(specExample({}, "customer", "retrieve", "/customers/{customer-id}", {}, { parameters: [
      { name: "customer-id", in: "path", example: "-help", schema: { type: "string" } },
    ] })).toBeUndefined();
    expect(specExample({}, "invoice", "retrieve", "/invoices/{invoice-id}", {}, { parameters: [
      { name: "invoice-id", in: "path", schema: { type: "string" } },
    ] })).toEqual(["<invoice-id>"]);
  });

  it("preserves derived array-of-object data through CLI parsing and SDK encoding", async () => {
    const args = specExample({}, "subscription", "create-with-items", "/subscriptions", {}, {
      requestBody: { content: { "application/x-www-form-urlencoded": {
        schema: { type: "object", required: ["subscription_items"], properties: {
          subscription_items: { type: "array", items: { type: "object", required: ["item_price_id"], properties: {
            item_price_id: { type: "string" }, quantity: { type: "integer" },
          } } },
        } },
        example: { subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }] },
      } } },
    });
    expect(args).toEqual(["-d", 'subscription_items=[{"item_price_id":"basic-USD","quantity":1}]']);
    const params = parseDataFlags([args![1]]);
    expect(params).toEqual({ subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }] });
    const { encodeParams } = await import(join(import.meta.dir, "../../../../node_modules/chargebee/esm/util.js"));
    const body = new URLSearchParams(encodeParams(params));
    expect(body.get("subscription_items[item_price_id][0]")).toBe("basic-USD");
    expect(body.get("subscription_items[quantity][0]")).toBe("1");
  });

  it("does not derive examples outside the small allowlist", () => {
    expect(specExample({}, "customer", "add-contact", "/customers/{id}", {}, {})).toBeUndefined();
  });
});
