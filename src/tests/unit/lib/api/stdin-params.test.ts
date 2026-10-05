import { afterEach, describe, expect, it, spyOn } from "bun:test";

// The SDK's form encoder is shipped without declarations. These tests lock the wire format.
// @ts-expect-error chargebee/esm/util.js has no bundled types.
import { encodeListParams, encodeParams, serialize } from "../../../../../node_modules/chargebee/esm/util.js";
import {
  __setStdinSource,
  loadOperationParams,
  parseStdinParams,
  readJsonMarker,
  resolveOperationParams,
  StdinParamsError,
  takeResourceId,
  warnBareJsonFilters,
} from "../../../../lib/api/stdin-params.js";
import { setStdinIsTTY } from "../../../../lib/test-support/_helpers.js";

function exitCommand(): { error(message: string): never } {
  return {
    error(message: string): never {
      throw new Error(message);
    },
  };
}

function form(encoded: string): string {
  return decodeURIComponent(encoded.replace(/\+/g, " "));
}

function post(params: Record<string, unknown>): string {
  return form(encodeParams(structuredClone(params)));
}

function list(params: Record<string, unknown>): string {
  return form(encodeListParams(serialize(structuredClone(params))));
}

afterEach(() => {
  __setStdinSource(null);
});

describe("parseStdinParams", () => {
  it("keeps scalars, nested objects, and arrays of objects", () => {
    expect(
      parseStdinParams(
        JSON.stringify({
          id: "foo",
          channel: "web",
          net_term_days: 10,
          auto_collection: "off",
          billing_address: { city: "San Francisco", line1: "1 Market" },
          subscription_items: [
            { item_price_id: "basic-USD", quantity: 1 },
            { item_price_id: "addon-USD", quantity: 2 },
          ],
          coupon_ids: ["SUMMER", "WELCOME"],
        }),
      ),
    ).toEqual({
      id: "foo",
      channel: "web",
      net_term_days: 10,
      auto_collection: "off",
      billing_address: { city: "San Francisco", line1: "1 Market" },
      subscription_items: [
        { item_price_id: "basic-USD", quantity: 1 },
        { item_price_id: "addon-USD", quantity: 2 },
      ],
      coupon_ids: ["SUMMER", "WELCOME"],
    });
  });

  it("expands bracket keys into the object the SDK form-encodes", () => {
    const fromBrackets = parseStdinParams(
      JSON.stringify({
        "email[is]": "ada@example.com",
        "status[in]": ["active", "paused"],
        "customer[email][is]": "ada@example.com",
        "created_at[between]": [1609459200, 1640995200],
      }),
    );
    const nested = {
      email: { is: "ada@example.com" },
      status: { in: ["active", "paused"] },
      customer: { email: { is: "ada@example.com" } },
      created_at: { between: [1609459200, 1640995200] },
    };
    expect(fromBrackets).toEqual(nested);
    expect(post(fromBrackets)).toBe(post(nested));
    expect(list(fromBrackets)).toBe(list(nested));
    expect(post(nested)).toContain('status[in]=["active","paused"]');
    expect(list(nested)).toContain("customer[email][is]=ada@example.com");
  });

  it("form-encodes create bodies and list filters", () => {
    const createBody = parseStdinParams(
      JSON.stringify({
        id: "foo",
        net_term_days: 10,
        billing_address: { city: "San Francisco", line1: "1 Market" },
        subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }],
      }),
    );
    expect(post(createBody)).toBe(
      "id=foo&net_term_days=10&billing_address[city]=San Francisco&billing_address[line1]=1 Market&subscription_items[item_price_id][0]=basic-USD&subscription_items[quantity][0]=1",
    );

    const filters = parseStdinParams(
      JSON.stringify({
        limit: 10,
        offset: ["1788773014000", "73645044"],
        email: { is: "ada@example.com" },
        status: { in: ["active", "paused"] },
      }),
    );
    expect(list(filters)).toBe(
      'limit=10&offset=["1788773014000","73645044"]&email[is]=ada@example.com&status[in]=["active","paused"]',
    );
  });

  it("rejects empty, invalid, and non-object stdin", () => {
    expect(() => parseStdinParams("   ")).toThrow(StdinParamsError);
    expect(() => parseStdinParams("{")).toThrow(/not valid JSON/);
    expect(() => parseStdinParams('["a"]')).toThrow(/JSON object/);
    expect(() => parseStdinParams("1")).toThrow(/JSON object/);
    expect(() => parseStdinParams("null")).toThrow(/JSON object/);
  });

  it("rejects conflicting and invalid keys", () => {
    expect(() => parseStdinParams('{"email":"a","email[is]":"b"}')).toThrow(/conflicting parameter 'email'/);
    expect(() => parseStdinParams('{"email[is]":"a","email":{"is":"b"}}')).toThrow(/conflicting parameter 'email'/);
    expect(() => parseStdinParams('{"email[":"a"}')).toThrow(/invalid parameter key/);
  });

  it("merges bracket keys that share a nested parent", () => {
    expect(
      parseStdinParams(
        '{"billing_address[city]":"Paris","billing_address[zip]":"75001","card[billing_addr][line1]":"1 Rue","card[billing_addr][line2]":"Apt 2"}',
      ),
    ).toEqual({
      billing_address: { city: "Paris", zip: "75001" },
      card: { billing_addr: { line1: "1 Rue", line2: "Apt 2" } },
    });
  });

  it("names the full path when a deeper key collides with one already set", () => {
    expect(() => parseStdinParams('{"customer[email][is]":"a","customer[email]":"b"}')).toThrow(
      /conflicting parameter 'customer\[email\]'/,
    );
    expect(() => parseStdinParams('{"customer[email]":"a","customer[email][is]":"b"}')).toThrow(
      /conflicting parameter 'customer\[email\]'/,
    );
  });
});

describe("resolveOperationParams", () => {
  it("uses -d when stdin is not requested", async () => {
    await expect(resolveOperationParams(["email[is]=ada@example.com"], false)).resolves.toEqual({
      email: { is: "ada@example.com" },
    });
  });

  it("reads a JSON object from the stdin source", async () => {
    const restore = setStdinIsTTY(false);
    __setStdinSource(async function* () {
      yield '{"city":"Paris"}';
      yield "";
    });
    try {
      await expect(resolveOperationParams([], true)).resolves.toEqual({ city: "Paris" });
    } finally {
      restore();
    }
  });

  it("reads buffer chunks", async () => {
    const restore = setStdinIsTTY(false);
    __setStdinSource(async function* () {
      yield Buffer.from('{"id":"foo"}');
    });
    try {
      await expect(resolveOperationParams([], true)).resolves.toEqual({ id: "foo" });
    } finally {
      restore();
    }
  });

  it("reads process.stdin once the test source is cleared", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          yield '{"id":"foo"}';
        },
      },
    });
    __setStdinSource(null);
    try {
      await expect(resolveOperationParams([], true)).resolves.toEqual({ id: "foo" });
    } finally {
      if (original) Object.defineProperty(process, "stdin", original);
    }
  });

  it("refuses a terminal and refuses mixing -d with stdin", async () => {
    const restore = setStdinIsTTY(true);
    try {
      await expect(resolveOperationParams([], true)).rejects.toThrow(/terminal/);
    } finally {
      restore();
    }
    await expect(resolveOperationParams(["id=foo"], true)).rejects.toThrow(/not both/);
  });
});

describe("argument markers", () => {
  it("accepts '-' and rejects any other extra argument", () => {
    expect(readJsonMarker(undefined, exitCommand())).toBe(false);
    expect(readJsonMarker("-", exitCommand())).toBe(true);
    expect(() => readJsonMarker("nope", exitCommand())).toThrow(/unexpected argument 'nope'/);
  });

  it("keeps the resource id in front of '-'", () => {
    expect(takeResourceId("cust_123", "-", exitCommand())).toEqual({ id: "cust_123", fromStdin: true });
    expect(takeResourceId("cust_123", undefined, exitCommand())).toEqual({
      id: "cust_123",
      fromStdin: false,
    });
    expect(() => takeResourceId("-", undefined, exitCommand())).toThrow(/Pass the resource id before/);
    expect(() => takeResourceId("cust_123", "extra", exitCommand())).toThrow(/unexpected argument 'extra'/);
  });

  it("reports stdin failures through the command error", async () => {
    const restoreTty = setStdinIsTTY(true);
    try {
      await expect(loadOperationParams([], true, exitCommand())).rejects.toThrow(/terminal/);
    } finally {
      restoreTty();
    }
    const restore = setStdinIsTTY(false);
    __setStdinSource(async function* () {
      yield "[]";
    });
    try {
      await expect(loadOperationParams([], true, exitCommand())).rejects.toThrow(/JSON object/);
    } finally {
      restore();
    }
  });
});

describe("warnBareJsonFilters", () => {
  it("warns on a scalar filter and skips operator objects and pagination keys", () => {
    const notes: string[] = [];
    warnBareJsonFilters(
      {
        email: "ada@example.com",
        status: { is: "active" },
        limit: 10,
        offset: ["1", "2"],
      },
      "customer",
      (msg) => notes.push(msg),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("email[is]=ada@example.com");
    expect(notes[0]).toContain("chargebee docs customer list");
  });

  it("writes to stderr by default", () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((msg: string) => {
      written.push(String(msg));
      return true;
    }) as never);
    try {
      warnBareJsonFilters({ email: "ada@example.com" }, "customer");
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toContain("email[is]=ada@example.com");
  });
});


describe("parameter key safety", () => {
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    it(`rejects ${segment} at every path position without changing inherited properties`, () => {
      const probe = "__parameter_safety_probe__";
      for (const key of [segment, `${segment}[${probe}]`, `customer[${segment}]`, `customer[${segment}][${probe}]`]) {
        try {
          expect(() => parseStdinParams(JSON.stringify({ [key]: "review-value" }))).toThrow(/invalid parameter key/i);
          expect(Object.hasOwn(Object.prototype, probe)).toBe(false);
        } finally {
          delete (Object.prototype as Record<string, unknown>)[probe];
        }
      }
    });
  }
  it("creates an own object for a harmless inherited property name", () => {
    const key = "toString[value]";
    const result = parseStdinParams(JSON.stringify({ [key]: "review-value" }));
    expect(Object.hasOwn(result, "toString")).toBe(true);
    expect(result["toString"] as unknown).toEqual({ value: "review-value" });
  });
});
