/**
 * A JSON object on stdin and `-d key=value` build the same params object, and
 * the SDK form-encodes it. These cases drive a real SDK client with a capturing
 * HTTP client and pin the encoded request for each input shape: scalars,
 * arrays, nested objects, arrays of objects, JSON-valued fields, and filters.
 */
import { describe, expect, it } from "bun:test";
import Chargebee from "chargebee";

import { parseStdinParams } from "../../../../lib/api/stdin-params.js";
import { parseDataFlags } from "../../../../lib/codesample/index.js";

type Params = Record<string, unknown>;

let captured: { url: string; body: string } | undefined;

const client = new Chargebee({
  site: "acme-test",
  apiKey: "test_key",
  httpClient: {
    async makeApiRequest(request: Request) {
      captured = { url: request.url, body: await request.text() };
      return new Response(JSON.stringify({ list: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
} as never) as never as {
  customer: { create(p: Params): Promise<unknown>; list(p: Params): Promise<unknown> };
  export: { customers(p: Params): Promise<unknown> };
};

/** Decoded so expectations read like the `--data-urlencode` values they mirror. */
function decode(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

/** Form body the SDK posts for `customer create`. */
async function createBody(params: Params): Promise<string> {
  await client.customer.create(params);
  return decode(captured?.body ?? "");
}

/** Query string the SDK sends for `customer list`. */
async function listQuery(params: Params): Promise<string> {
  await client.customer.list(params);
  return decode(new URL(captured?.url ?? "https://x/").search.replace(/^\?/, ""));
}

/** Form body the SDK posts for `export customers`. */
async function exportBody(params: Params): Promise<string> {
  await client.export.customers(params);
  return decode(captured?.body ?? "");
}

interface Case {
  name: string;
  json: Params;
  params: Params;
  create: string;
  /** Set for shapes that are also valid on a list call. */
  list?: string;
  /** `-d` flags that must produce the same params object. */
  dataFlags?: string[];
}

const cases: Case[] = [
  {
    name: "string, integer, float, and boolean values",
    json: { id: "foo", net_term_days: 10, mrr: 10.5, allow_direct_debit: false },
    params: { id: "foo", net_term_days: 10, mrr: 10.5, allow_direct_debit: false },
    create: "id=foo&net_term_days=10&mrr=10.5&allow_direct_debit=false",
    list: "id=foo&net_term_days=10&mrr=10.5&allow_direct_debit=false",
  },
  {
    name: "empty string is sent and null is dropped",
    json: { first_name: "", last_name: null, id: "foo" },
    params: { first_name: "", last_name: null, id: "foo" },
    create: "first_name=&id=foo",
    list: "first_name=&id=foo",
  },
  {
    name: "nested object",
    json: { billing_address: { city: "San Francisco", line1: "1 Market" } },
    params: { billing_address: { city: "San Francisco", line1: "1 Market" } },
    create: "billing_address[city]=San Francisco&billing_address[line1]=1 Market",
    dataFlags: ["billing_address[city]=San Francisco", "billing_address[line1]=1 Market"],
  },
  {
    name: "JSON-valued field stays a JSON string on the wire",
    json: { meta_data: { source: "api", environment: "test" } },
    params: { meta_data: { source: "api", environment: "test" } },
    create: 'meta_data={"source":"api","environment":"test"}',
    dataFlags: ['meta_data={"source":"api","environment":"test"}'],
  },
  {
    name: "array of strings",
    json: { coupon_ids: ["SUMMER", "WELCOME"] },
    params: { coupon_ids: ["SUMMER", "WELCOME"] },
    create: "coupon_ids[0]=SUMMER&coupon_ids[1]=WELCOME",
    list: 'coupon_ids=["SUMMER","WELCOME"]',
    dataFlags: ['coupon_ids=["SUMMER","WELCOME"]'],
  },
  {
    name: "array of objects",
    json: {
      subscription_items: [
        { item_price_id: "basic-USD", quantity: 1 },
        { item_price_id: "addon-USD", quantity: 2 },
      ],
    },
    params: {
      subscription_items: [
        { item_price_id: "basic-USD", quantity: 1 },
        { item_price_id: "addon-USD", quantity: 2 },
      ],
    },
    create:
      "subscription_items[item_price_id][0]=basic-USD&subscription_items[quantity][0]=1" +
      "&subscription_items[item_price_id][1]=addon-USD&subscription_items[quantity][1]=2",
    dataFlags: [
      'subscription_items=[{"item_price_id":"basic-USD","quantity":1},{"item_price_id":"addon-USD","quantity":2}]',
    ],
  },
  {
    name: "empty array and empty object",
    json: { coupon_ids: [], billing_address: {}, id: "foo" },
    params: { coupon_ids: [], billing_address: {}, id: "foo" },
    create: "id=foo",
    list: "coupon_ids=[]&id=foo",
  },
  {
    name: "list filters: is, in, between, starts_with, gt",
    json: {
      limit: 10,
      email: { is: "ada@example.com" },
      status: { in: ["active", "paused"] },
      created_at: { between: [1609459200, 1640995200] },
      first_name: { starts_with: "Ad" },
      mrr: { gt: "100" },
    },
    params: {
      limit: 10,
      email: { is: "ada@example.com" },
      status: { in: ["active", "paused"] },
      created_at: { between: [1609459200, 1640995200] },
      first_name: { starts_with: "Ad" },
      mrr: { gt: "100" },
    },
    create:
      'limit=10&email[is]=ada@example.com&status[in]=["active","paused"]' +
      "&created_at[between]=[1609459200,1640995200]&first_name[starts_with]=Ad&mrr[gt]=100",
    list:
      'limit=10&email[is]=ada@example.com&status[in]=["active","paused"]' +
      "&created_at[between]=[1609459200,1640995200]&first_name[starts_with]=Ad&mrr[gt]=100",
    dataFlags: [
      "limit=10",
      "email[is]=ada@example.com",
      'status[in]=["active","paused"]',
      "created_at[between]=[1609459200,1640995200]",
      "first_name[starts_with]=Ad",
      "mrr[gt]=100",
    ],
  },
  {
    name: "pagination cursor from a previous response",
    json: { offset: ["1788773014000", "73645044"], limit: 5 },
    params: { offset: ["1788773014000", "73645044"], limit: 5 },
    create: "offset[0]=1788773014000&offset[1]=73645044&limit=5",
    list: 'offset=["1788773014000","73645044"]&limit=5',
    dataFlags: ['offset=["1788773014000","73645044"]', "limit=5"],
  },
  {
    name: "values needing percent-encoding",
    json: { email: "a+b@example.com", note: "a&b=c d", first_name: "Ada Ünicode" },
    params: { email: "a+b@example.com", note: "a&b=c d", first_name: "Ada Ünicode" },
    create: "email=a+b@example.com&note=a&b=c d&first_name=Ada Ünicode",
    list: "email=a+b@example.com&note=a&b=c d&first_name=Ada Ünicode",
  },
];

describe("stdin JSON to form encoding", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const params = parseStdinParams(JSON.stringify(c.json));
      expect(params).toEqual(c.params);
      expect(await createBody(params)).toBe(c.create);
      if (c.list !== undefined) expect(await listQuery(params)).toBe(c.list);
    });
  }

  it("matches -d for the same parameters", async () => {
    for (const c of cases) {
      if (!c.dataFlags) continue;
      const fromStdin = parseStdinParams(JSON.stringify(c.json));
      expect(await createBody(parseDataFlags(c.dataFlags))).toBe(await createBody(fromStdin));
    }
  });

  it("encodes bracket keys the same as nested objects", async () => {
    const flat = parseStdinParams(
      JSON.stringify({
        "email[is]": "ada@example.com",
        "status[in]": ["active", "paused"],
        "customer[email][is]": "ada@example.com",
      }),
    );
    const nested = parseStdinParams(
      JSON.stringify({
        email: { is: "ada@example.com" },
        status: { in: ["active", "paused"] },
        customer: { email: { is: "ada@example.com" } },
      }),
    );
    expect(flat).toEqual(nested);
    expect(await listQuery(flat)).toBe(await listQuery(nested));
    expect(await exportBody(flat)).toBe(await exportBody(nested));
  });

  /**
   * The SDK's GET serializer reuses the mutated key across sibling sub-keys, so
   * a second operator on one field lands under the first. `-d` builds the same
   * params object and hits it too. One operator per field is unaffected, and
   * POST bodies encode both siblings.
   */
  it("shows the SDK GET limit for two operators on one field", async () => {
    const params = parseStdinParams(
      JSON.stringify({ created_at: { after: "1609459200", before: "1640995200" } }),
    );
    expect(await createBody(params)).toBe("created_at[after]=1609459200&created_at[before]=1640995200");
    expect(await listQuery(params)).toBe("created_at[after]=1609459200&created_at[after][before]=1640995200");
    expect(await listQuery(parseDataFlags(["created_at[after]=1609459200", "created_at[before]=1640995200"]))).toBe(
      await listQuery(params),
    );
  });
});

/**
 * Each case mirrors a documented cURL request field for field. The CLI hands
 * the params object to the SDK, and the SDK produces the same request.
 */
describe("cURL request parity", () => {
  it("creates a customer with an address and JSON metadata", async () => {
    const json = {
      id: "cust_demo_001",
      first_name: "John",
      last_name: "Doe",
      email: "john.doe@example.com",
      preferred_currency_code: "USD",
      phone: "+1-555-0100",
      company: "Example Corporation",
      auto_collection: "on",
      net_term_days: 0,
      allow_direct_debit: false,
      taxability: "taxable",
      meta_data: { source: "api", environment: "test" },
      billing_address: {
        first_name: "John",
        last_name: "Doe",
        line1: "123 Main Street",
        city: "San Francisco",
        state: "CA",
        zip: "94105",
        country: "US",
      },
    };
    const expected =
      "id=cust_demo_001&first_name=John&last_name=Doe&email=john.doe@example.com" +
      "&preferred_currency_code=USD&phone=+1-555-0100&company=Example Corporation" +
      "&auto_collection=on&net_term_days=0&allow_direct_debit=false&taxability=taxable" +
      '&meta_data={"source":"api","environment":"test"}' +
      "&billing_address[first_name]=John&billing_address[last_name]=Doe" +
      "&billing_address[line1]=123 Main Street&billing_address[city]=San Francisco" +
      "&billing_address[state]=CA&billing_address[zip]=94105&billing_address[country]=US";

    expect(await createBody(parseStdinParams(JSON.stringify(json)))).toBe(expected);
    expect(
      await createBody(
        parseDataFlags([
          "id=cust_demo_001",
          "first_name=John",
          "last_name=Doe",
          "email=john.doe@example.com",
          "preferred_currency_code=USD",
          "phone=+1-555-0100",
          "company=Example Corporation",
          "auto_collection=on",
          "net_term_days=0",
          "allow_direct_debit=false",
          "taxability=taxable",
          'meta_data={"source":"api","environment":"test"}',
          "billing_address[first_name]=John",
          "billing_address[last_name]=Doe",
          "billing_address[line1]=123 Main Street",
          "billing_address[city]=San Francisco",
          "billing_address[state]=CA",
          "billing_address[zip]=94105",
          "billing_address[country]=US",
        ]),
      ),
    ).toBe(expected);
  });

  it("lists customers with pagination, sort, and one operator per field", async () => {
    const json = {
      limit: 10,
      offset: "demo_offset",
      include_deleted: false,
      sort_by: { asc: "created_at" },
      id: { is: "cust_demo_001" },
      first_name: { is: "John" },
      last_name: { is: "Doe" },
      email: { is: "john.doe@example.com" },
      company: { is_not: "Test Company" },
      phone: { is_not: "+1-555-9999" },
      auto_collection: { is: "on" },
      taxability: { is: "taxable" },
      created_at: { before: 1700000000 },
      updated_at: { after: 1690000000 },
      offline_payment_method: { is: "cash" },
      auto_close_invoices: { is: false },
      channel: { is: "web" },
      business_entity_id: { is: "business_entity_demo" },
    };
    const expected =
      "limit=10&offset=demo_offset&include_deleted=false&sort_by[asc]=created_at" +
      "&id[is]=cust_demo_001&first_name[is]=John&last_name[is]=Doe&email[is]=john.doe@example.com" +
      "&company[is_not]=Test Company&phone[is_not]=+1-555-9999&auto_collection[is]=on" +
      "&taxability[is]=taxable&created_at[before]=1700000000&updated_at[after]=1690000000" +
      "&offline_payment_method[is]=cash&auto_close_invoices[is]=false&channel[is]=web" +
      "&business_entity_id[is]=business_entity_demo";

    expect(await listQuery(parseStdinParams(JSON.stringify(json)))).toBe(expected);
    expect(
      await listQuery(
        parseDataFlags([
          "limit=10",
          "offset=demo_offset",
          "include_deleted=false",
          "sort_by[asc]=created_at",
          "id[is]=cust_demo_001",
          "first_name[is]=John",
          "last_name[is]=Doe",
          "email[is]=john.doe@example.com",
          "company[is_not]=Test Company",
          "phone[is_not]=+1-555-9999",
          "auto_collection[is]=on",
          "taxability[is]=taxable",
          "created_at[before]=1700000000",
          "updated_at[after]=1690000000",
          "offline_payment_method[is]=cash",
          "auto_close_invoices[is]=false",
          "channel[is]=web",
          "business_entity_id[is]=business_entity_demo",
        ]),
      ),
    ).toBe(expected);
  });

  it("lists customers with only a limit", async () => {
    expect(await listQuery(parseStdinParams('{"limit":10}'))).toBe("limit=10");
  });

  it("sends no parameters for an empty object", async () => {
    expect(await createBody(parseStdinParams("{}"))).toBe("");
  });

  it("exports customers with a nested resource filter", async () => {
    const json = {
      export_type: "data",
      business_entity_id: { is: "business_entity_demo" },
      customer: { id: { is: "cust_demo_001" }, email: { is: "john.doe@example.com" } },
    };
    const expected =
      "export_type=data&business_entity_id[is]=business_entity_demo" +
      "&customer[id][is]=cust_demo_001&customer[email][is]=john.doe@example.com";

    expect(await exportBody(parseStdinParams(JSON.stringify(json)))).toBe(expected);
    expect(
      await exportBody(
        parseDataFlags([
          "export_type=data",
          "business_entity_id[is]=business_entity_demo",
          "customer[id][is]=cust_demo_001",
          "customer[email][is]=john.doe@example.com",
        ]),
      ),
    ).toBe(expected);
  });
});
