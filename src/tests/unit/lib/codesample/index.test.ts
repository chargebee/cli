import { describe, expect, it, spyOn } from "bun:test";
import { parseStdinParams } from "../../../../lib/api/stdin-params.js";

import {
  CANONICAL_LANGUAGES,
  CODE_SAMPLE_OPTION_HELP,
  formatLanguageList,
  generate,
  isSupportedLanguage,
  LIST_OPS_DOC_URL,
  parseDataFlags,
  resolveLanguage,
  warnBareListFilters,
} from "../../../../lib/codesample/index.js";

// The Chargebee SDK's list serializer JSON-encodes the values of the array
// operators `in`, `not_in`, `between`. Passing those as real arrays (below)
// makes the SDK emit `id[in]=["a","b"]`; passing them as JSON *strings* would
// double-encode to `id[in]="[\"a\"]"` and the API rejects it as `wrong format`.
describe("parseDataFlags", () => {
  it("parses JSON array filters into real arrays (id[in])", () => {
    expect(parseDataFlags(['id[in]=["silver","murali"]'])).toEqual({
      id: { in: ["silver", "murali"] },
    });
  });

  it("parses id[not_in] into a real array", () => {
    expect(parseDataFlags(['id[not_in]=["a"]'])).toEqual({
      id: { not_in: ["a"] },
    });
  });

  it("parses [between] into a real array", () => {
    expect(parseDataFlags(["created_at[between]=[1,2]"])).toEqual({
      created_at: { between: [1, 2] },
    });
  });

  it("keeps scalar operators as strings (first_name[is])", () => {
    expect(parseDataFlags(["first_name[is]=John"])).toEqual({
      first_name: { is: "John" },
    });
  });

  it("keeps nested sub-resource strings (billing_address[line1])", () => {
    expect(parseDataFlags(["billing_address[line1]=John"])).toEqual({
      billing_address: { line1: "John" },
    });
  });

  it("groups field-first indexed parameters into item objects", () => {
    expect(parseDataFlags([
      "subscription_items[item_price_id][0]=basic-USD",
      "subscription_items[quantity][0]=1",
      "subscription_items[item_price_id][1]=day-pass-USD",
      "subscription_items[unit_price][1]=100",
    ])).toEqual({
      subscription_items: [
        { item_price_id: "basic-USD", quantity: "1" },
        { item_price_id: "day-pass-USD", unit_price: "100" },
      ],
    });
  });

  it("rejects an impractically large indexed parameter", () => {
    expect(() => parseDataFlags(["subscription_items[item_price_id][10001]=basic-USD"]))
      .toThrow("Invalid indexed parameter");
  });

  it("keeps plain scalar values as strings", () => {
    expect(parseDataFlags(["limit=5"])).toEqual({ limit: "5" });
  });

  it("parses top-level JSON object values (metadata)", () => {
    expect(parseDataFlags(['metadata={"k":"v"}'])).toEqual({
      metadata: { k: "v" },
    });
  });

  it("falls back to the raw string on malformed JSON", () => {
    expect(parseDataFlags(["id[in]=[oops"])).toEqual({
      id: { in: "[oops" },
    });
  });

  it.each(["eamil", "", "=value", "   =value"])("rejects malformed data %j", (data) => {
    expect(() => parseDataFlags([data])).toThrow("Expected a non-empty key=value pair");
  });

  it("does not discard malformed input alongside valid parameters", () => {
    expect(() => parseDataFlags(["email=ada@example.com", "eamil"])).toThrow('"eamil"');
  });

  it("preserves empty values, equals signs, and repeated-key behavior", () => {
    expect(parseDataFlags(["email=", "notes=a=b=c", "first_name=Old", "first_name=Ada"])).toEqual({
      email: "",
      notes: "a=b=c",
      first_name: "Ada",
    });
  });
});

describe("code-sample parameter validation", () => {
  const sample = (data: string[]) => generate({
    operationId: "create_a_customer",
    language: "python",
    params: parseDataFlags(data),
  });

  it("rejects unknown top-level and nested field names", async () => {
    await expect(sample(["eamil=ada@example.com"])).rejects.toThrow('Unknown field "eamil"');
    await expect(sample(["billing_address[ctiy]=Chennai"])).rejects.toThrow('Unknown field "ctiy"');
  });

  it("checks required fields using the selected catalog schema", async () => {
    await expect(generate({ operationId: "create_a_plan", language: "go", pcVersion: "v1" }))
      .rejects.toThrow('Required field "id" is missing');
    const code = await generate({
      operationId: "create_a_plan", language: "go", pcVersion: "v1",
      params: { id: "basic", name: "Basic" },
    });
    expect(code).toContain("basic");
  });

  it("checks required fields inside a supplied nested object", async () => {
    await expect(generate({
      operationId: "create_subscription_for_items", language: "python",
      params: { subscription_items: { quantity: "1" } },
    })).rejects.toThrow('Required field "item_price_id" is missing');
  });

  it("generates the documented field-first indexed form for two subscription items", async () => {
    const data = [
      "subscription_items[item_price_id][0]=basic-USD",
      "subscription_items[billing_cycles][0]=2",
      "subscription_items[quantity][0]=1",
      "subscription_items[item_price_id][1]=day-pass-USD",
      "subscription_items[unit_price][1]=100",
    ];
    const options = {
      operationId: "create_subscription_for_items",
      resourceId: "cus_demo",
      pathParamName: "customer-id",
      params: parseDataFlags(data),
    };
    const curl = await generate({ ...options, language: "curl" });
    for (const flag of data) {
      const [key, value] = flag.split("=");
      expect(curl).toContain(`-d "${key}"=${/^\d+$/.test(value) ? value : `"${value}"`}`);
    }
    expect(curl).not.toContain("-d subscription_items=");

    const python = await generate({ ...options, language: "python" });
    expect(python.match(/CreateWithItemsSubscriptionItemParams\(/g)).toHaveLength(2);
    expect(python).toContain('item_price_id="basic-USD"');
    expect(python).toContain('item_price_id="day-pass-USD"');
    expect(python).toContain("unit_price=100");
  });

  it("uses the same indexed form for JSON stdin arrays and bracket keys", async () => {
    const inputs = [
      { subscription_items: [
        { item_price_id: "basic-USD", quantity: 1 },
        { item_price_id: "day-pass-USD", unit_price: 100 },
      ] },
      {
        "subscription_items[item_price_id][0]": "basic-USD",
        "subscription_items[quantity][0]": 1,
        "subscription_items[item_price_id][1]": "day-pass-USD",
        "subscription_items[unit_price][1]": 100,
      },
    ];
    for (const input of inputs) {
      const curl = await generate({
        operationId: "create_subscription_for_items", language: "curl",
        params: parseStdinParams(JSON.stringify(input)),
      });
      expect(curl).toContain('"subscription_items[item_price_id][0]"="basic-USD"');
      expect(curl).toContain('"subscription_items[quantity][0]"=1');
      expect(curl).toContain('"subscription_items[item_price_id][1]"="day-pass-USD"');
      expect(curl).toContain('"subscription_items[unit_price][1]"=100');
    }
  });

  it("still rejects a misspelled indexed item field", async () => {
    await expect(generate({
      operationId: "create_subscription_for_items", language: "curl",
      params: parseDataFlags(["subscription_items[item_prcie_id][0]=basic-USD"]),
    })).rejects.toThrow('Unknown field "item_prcie_id"');
  });

  it("accepts CLI boolean and numeric strings", async () => {
    const code = await sample(["allow_direct_debit=true", "net_term_days=30"]);
    expect(code).toContain("allow_direct_debit=True");
    expect(code).toContain("net_term_days=30");
  });

  it("leaves enum value validation to the API", async () => {
    const code = await sample(["auto_collection=invalid"]);
    expect(code).toContain("invalid");
  });

  it("preserves nested values and free-form metadata", async () => {
    const code = await sample(["billing_address[city]=Chennai", 'meta_data={"source":"cli"}']);
    expect(code).toContain("Chennai");
    expect(code).toContain('"source": "cli"');
  });

  it("preserves custom fields absent from the public schema", async () => {
    const code = await sample(["cf_example=demo"]);
    expect(code).toContain("cf_example");
    expect(code).toContain("demo");
  });

  it("does not let a custom field mask a typo or missing required field", async () => {
    await expect(sample(["cf_example=demo", "eamil=ada@example.com"]))
      .rejects.toThrow('Unknown field "eamil"');
    await expect(generate({
      operationId: "create_a_plan", language: "go", pcVersion: "v1",
      params: { cf_example: "demo" },
    })).rejects.toThrow('Required field "id" is missing');
  });

  it("preserves list filter operators and JSON array values", async () => {
    const code = await generate({
      operationId: "list_customers", language: "python",
      params: parseDataFlags(['id[in]=["a","b"]', "limit=5"]),
    });
    expect(code).toContain("Filters.StringFilter");
    expect(code).toContain('"a"');
    expect(code).toContain('"b"');
  });

  it("propagates generator errors unrelated to parameter validation", async () => {
    await expect(generate({ operationId: "nonexistent_operation", language: "python" }))
      .rejects.toThrow();
  });
});

describe("resource IDs in code samples", () => {
  it("generates from bundled data without making an API request or using site credentials", async () => {
    const fetchStub = Object.assign(
      async () => { throw new Error("unexpected network request"); },
      { preconnect: globalThis.fetch.preconnect },
    ) as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchStub);

    try {
      const code = await generate({
        operationId: "retrieve_a_customer",
        language: "curl",
        method: "GET",
        resourceId: "cus_demo",
        pathParamName: "customer-id",
      });

      expect(code).toContain("your-site.chargebee.com/api/v2/customers/cus_demo");
      expect(code).toContain("test_api_key");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("maps a customer ID to the retrieve path without mutating supplied params", async () => {
    const params = {};
    const code = await generate({
      operationId: "retrieve_a_customer",
      language: "curl",
      method: "GET",
      uri: "/customers/{id}",
      params,
      resourceId: "cus_demo",
      pathParamName: "customer-id",
    });

    expect(code).toContain("/customers/cus_demo");
    expect(code).toContain("test_api_key");
    expect(code).not.toContain("customer-id=");
    expect(params).toEqual({});
  });

  it("keeps an omitted customer ID as the generator placeholder", async () => {
    const code = await generate({
      operationId: "retrieve_a_customer",
      language: "curl",
      method: "GET",
      uri: "/customers/{id}",
    });

    expect(code).toContain("/customers/{customer-id}");
  });

  it("lets the positional resource ID override a data parameter without mutating it", async () => {
    const params = { "customer-id": "wrong_id" };
    const code = await generate({
      operationId: "retrieve_a_customer",
      language: "curl",
      method: "GET",
      params,
      resourceId: "cus_demo",
      pathParamName: "customer-id",
    });

    expect(code).toContain("/customers/cus_demo");
    expect(code).not.toContain("/customers/wrong_id");
    expect(params).toEqual({ "customer-id": "wrong_id" });
  });

  it("uses the resource ID and retains body fields for an update", async () => {
    const code = await generate({
      operationId: "update_a_customer",
      language: "python",
      method: "POST",
      uri: "/customers/{id}",
      params: { email: "ada@example.com" },
      resourceId: "cus_demo",
      pathParamName: "customer-id",
    });

    expect(code).toContain('Customer.update("cus_demo"');
    expect(code).toContain('email="ada@example.com"');
    expect(code).not.toContain("customer_id=");
  });

  it("uses a customer ID in the nested subscription route", async () => {
    const code = await generate({
      operationId: "create_subscription_for_items",
      language: "curl",
      method: "POST",
      uri: "/customers/{id}/subscription_for_items",
      params: { subscription_items: [{ item_price_id: "basic-USD", quantity: "1" }] },
      resourceId: "cus_demo",
      pathParamName: "customer-id",
    });

    expect(code).toContain("/customers/cus_demo/subscription_for_items");
    expect(code).toContain('"subscription_items[item_price_id][0]"="basic-USD"');
  });
});

describe("warnBareListFilters", () => {
  it("warns on a bare filter-looking key", () => {
    const lines: string[] = [];
    warnBareListFilters(["id=cbdemo_alex"], "customer", (m) => lines.push(m));
    expect(lines.join("")).toContain("id[is]=cbdemo_alex");
    expect(lines.join("")).toContain("chargebee docs customer list");
    expect(lines.join("")).toContain(LIST_OPS_DOC_URL);
  });

  it("does not warn on pagination keys or keys that already have an operator", () => {
    const lines: string[] = [];
    warnBareListFilters(
      ["limit=5", "offset=abc", "include_deleted=true", "id[is]=cbdemo_alex", "sort_by[asc]=created_at"],
      "customer",
      (m) => lines.push(m),
    );
    expect(lines).toEqual([]);
  });

  it("warns once per bare key, including customer_id", () => {
    const lines: string[] = [];
    warnBareListFilters(["customer_id=cust_abc123", "limit=10"], "invoice", (m) => lines.push(m));
    expect(lines.join("")).toContain("customer_id[is]=cust_abc123");
    expect(lines.join("")).not.toContain("limit[is]");
  });
});

describe("code-sample language names", () => {
  it("maps friendly names to generator ids and passes versioned ids through", () => {
    expect(resolveLanguage("python")).toBe("python-v3");
    expect(resolveLanguage("nodejs")).toBe("node-v3");
    expect(resolveLanguage("node")).toBe("node-v3");
    expect(resolveLanguage("java")).toBe("java-v4");
    expect(resolveLanguage("go")).toBe("go-v4");
    expect(resolveLanguage("python-v2")).toBe("python-v2");
    expect(resolveLanguage("GO")).toBe("go-v4");
  });

  it("accepts canonical names, aliases, and generator ids", () => {
    expect(isSupportedLanguage("python")).toBe(true);
    expect(isSupportedLanguage("nodejs")).toBe(true);
    expect(isSupportedLanguage("python-v3")).toBe(true);
    expect(isSupportedLanguage("nodfd")).toBe(false);
  });

  it("lists canonical names, not generator ids as the headline", () => {
    const listed = formatLanguageList();
    expect(listed).toContain("Supported languages:");
    for (const name of CANONICAL_LANGUAGES) {
      expect(listed).toContain(name);
    }
    expect(listed).toMatch(/^ {2}python\b/m);
    expect(listed).toContain("aliases: python-v3");
    expect(listed).toContain("node-v3");
    expect(listed).toContain("php-v3");
    expect(listed).toMatch(/go\s+aliases: go-v4/);
    expect(CODE_SAMPLE_OPTION_HELP).toContain("nodejs");
  });
});


describe("parameter key safety", () => {
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    it(`rejects ${segment} at every path position without changing inherited properties`, () => {
      const probe = "__parameter_safety_probe__";
      for (const key of [segment, `${segment}[${probe}]`, `customer[${segment}]`, `customer[${segment}][${probe}]`]) {
        try {
          expect(() => parseDataFlags([`${key}=review-value`])).toThrow(/invalid parameter key/i);
          expect(Object.hasOwn(Object.prototype, probe)).toBe(false);
        } finally {
          delete (Object.prototype as Record<string, unknown>)[probe];
        }
      }
    });
  }
  it("creates an own object for a harmless inherited property name", () => {
    const key = "toString[value]";
    const result = parseDataFlags([`${key}=review-value`]);
    expect(Object.hasOwn(result, "toString")).toBe(true);
    expect(result["toString"] as unknown).toEqual({ value: "review-value" });
  });
});
