import { describe, expect, it } from "bun:test";

import { buildParams, bracketPath, toSdkParams, typeJsonScalars } from "../../../../lib/api/params.js";
import { parseDataFlags } from "../../../../lib/codesample/index.js";
import { parseStdinParams } from "../../../../lib/api/stdin-params.js";

describe("canonical API parameters", () => {
  it("parses plain, nested, indexed, and field-first paths", () => {
    expect(bracketPath("a[b][0]")).toEqual(["a", "b", "0"]);
    for (const key of ["a[b", "a[]", "a]b", "[a]", "a[b]]", "a[constructor]"]) {
      expect(bracketPath(key)).toBeNull();
    }
    expect(parseDataFlags([
      "id=cus_1",
      "roles[0]=admin",
      "roles[1]=engineer",
      "subscription_items[item_price_id][0]=p1",
      "subscription_items[quantity][0]=2",
      "request_context[user_agent]=cli",
    ])).toEqual({
      id: "cus_1",
      roles: ["admin", "engineer"],
      subscription_items: [{ item_price_id: "p1", quantity: "2" }],
      request_context: { user_agent: "cli" },
    });
  });

  it("makes equivalent -d and JSON stdin inputs the same logical object", () => {
    const flags = [
      'coupon_ids=["A","B"]',
      "mandatory_items_to_remove[0]=p1",
      "mandatory_items_to_remove[1]=p2",
      'subscription[status][in]=["active","in_trial"]',
      "a[0][b]=x",
    ];
    const stdin = {
      coupon_ids: ["A", "B"],
      mandatory_items_to_remove: ["p1", "p2"],
      subscription: { status: { in: ["active", "in_trial"] } },
      a: [{ b: "x" }],
    };
    expect(parseDataFlags(flags)).toEqual(parseStdinParams(JSON.stringify(stdin)));
    expect(parseDataFlags(["coupon_ids=[A, B]"])).toEqual({ coupon_ids: ["A", "B"] });
    expect(parseDataFlags(["mandatory_items_to_remove[0]=p1", "mandatory_items_to_remove[1]=p2"]))
      .toEqual(parseDataFlags(["mandatory_items_to_remove=[p1,p2]"]));
    expect(parseStdinParams(JSON.stringify({ "mandatory_items_to_remove[0]": "p1", "mandatory_items_to_remove[1]": "p2" })))
      .toEqual({ mandatory_items_to_remove: ["p1", "p2"] });
  });

  it("preserves a JSON-looking indexed form value but parses real arrays for JSON input", () => {
    expect(parseDataFlags(['items[tags][0]=["a","b"]'])).toEqual({ items: [{ tags: '["a","b"]' }] });
    expect(parseDataFlags(["items[tags][0]=[a,b]"])).toEqual({ items: [{ tags: "[a,b]" }] });
    expect(parseDataFlags(['roles[0]=["a","b"]'], { jsonInput: true })).toEqual({ roles: [["a", "b"]] });
  });

  it("rejects container conflicts and sparse indexed arrays", () => {
    expect(() => parseDataFlags(["a=1", "a[b]=2"])).toThrow(/conflicting parameter 'a'/);
    expect(() => parseDataFlags(["a[b]=2", "a=1"])).toThrow(/conflicting parameter 'a'/);
    expect(() => parseDataFlags(["roles[1]=admin"])).toThrow(/Missing indexed parameter roles\[0\]/);
    expect(() => parseDataFlags(["roles[10001]=admin"])).toThrow(/Invalid indexed parameter/);
    expect(parseDataFlags(["id=old", "id=new"])).toEqual({ id: "new" });
    expect(() => buildParams([{ key: "id", path: ["id"], value: "x" }, { key: "id", path: ["id"], value: "y" }])).toThrow(/conflicting parameter/);
  });
});

describe("GET SDK adapter", () => {
  it("flattens siblings and nested filters without changing canonical params", () => {
    const params = { created_at: { after: "1", before: "2" }, subscription: { status: { in: ["active"] } }, roles: ["admin", "engineer"] };
    expect(toSdkParams(params, "GET")).toEqual({
      "created_at[after]": "1",
      "created_at[before]": "2",
      "subscription[status][in]": '["active"]',
      "roles[0]": "admin",
      "roles[1]": "engineer",
    });
    expect(params.created_at).toEqual({ after: "1", before: "2" });
    expect(toSdkParams(params, "POST")).toBe(params);
  });

  it("preserves top-level arrays as one JSON value for SDK list requests", () => {
    expect(toSdkParams({ offset: ["a", "b"], id: { in: ["x"] } }, "GET", true)).toEqual({
      offset: '["a","b"]', "id[in]": '["x"]',
    });
  });
});

describe("JSON-body schema scalars", () => {
  it("types declared numeric and boolean leaves while preserving strings and unknown fields", () => {
    const schema = {
      count: { t: "int" as const }, enabled: { t: "bool" as const }, id: { t: "str" as const },
      nested: { t: "obj" as const, p: { amount: { t: "num" as const } } },
      items: { t: "arr" as const, i: { t: "obj" as const, p: { quantity: { t: "int" as const } } } },
    };
    expect(typeJsonScalars({ count: "5", enabled: "true", id: "123", cf_custom: "42", nested: { amount: "1.5" }, items: [{ quantity: "2" }] }, schema))
      .toEqual({ count: 5, enabled: true, id: "123", cf_custom: "42", nested: { amount: 1.5 }, items: [{ quantity: 2 }] });
  });
});
