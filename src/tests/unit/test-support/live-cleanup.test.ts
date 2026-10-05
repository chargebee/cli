import { expect, it } from "bun:test";

// This helper is imported with fixture env set by a subprocess below so the
// ordinary source suite never needs real credentials or network access.
it("customer cleanup executes after an assertion failure and after an ambiguous creation failure", async () => {
  const { pathToFileURL } = await import("node:url");
  const helper = pathToFileURL(import.meta.dir + "/../../../lib/test-support/live.ts").href;
  const script = `
    import { withCustomer, testSites } from ${JSON.stringify(helper)};
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    for (const timeout of [false, true]) {
      const calls = [];
      let id;
      const execute = async (args, options) => {
        calls.push(args[1]);
        if (args[1] === "create") {
          id = JSON.parse(options.input).id;
          if (timeout) throw new Error("creation timed out");
          return ok(JSON.stringify({ customer: { id } }));
        }
        if (args[2] !== id) throw new Error("cleanup targeted a different customer");
        if (args[1] === "retrieve") return { ...ok(), exitCode: 5 };
        return ok();
      };
      let failed = false;
      try { await withCustomer(0, async () => { throw new Error("assertion failed"); }, execute); }
      catch (error) { failed = error instanceof AggregateError; }
      if (!failed || calls.join(",") !== "create,delete,retrieve") throw new Error("cleanup was not guaranteed");
    }
    let failedCleanup = false;
    try {
      await withCustomer(0, async () => {}, async (args, options) => {
        if (args[1] === "create") return ok(JSON.stringify({ customer: { id: JSON.parse(options.input).id } }));
        return { ...ok(), exitCode: 4 };
      });
    } catch (error) {
      failedCleanup = error instanceof AggregateError && error.errors.some(e => e.message.includes("manual cleanup required"));
    }
    if (!failedCleanup) throw new Error("failed deletion was reported as success");
    await withCustomer(0, async () => {}, async (args, options) => {
      if (args[1] === "create") return ok(JSON.stringify({ customer: { id: JSON.parse(options.input).id } }));
      if (args[1] === "retrieve") return ok(JSON.stringify({ customer: { id: args[2], deleted: true } }));
      return ok();
    });
    testSites[0].site = "fixture-live";
    let executed = false;
    try { await withCustomer(0, async () => {}, async () => { executed = true; return ok(); }); }
    catch {}
    if (executed) throw new Error("live site reached customer mutation helper");
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, CB_TEST_SITE_1: "fixture-one-test", CB_TEST_KEY_1: "test_fake", CB_TEST_SITE_2: "fixture-two-test", CB_TEST_KEY_2: "test_fake" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}, 15_000);
