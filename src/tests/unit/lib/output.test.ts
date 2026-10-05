import { beforeEach, afterEach, expect, it, spyOn } from "bun:test";
import { diagnostic, finishOutput, humanLog, isJsonMode, jsonResult, outputCompleted, printJson, streamRecord, withJsonOutput } from "../../../lib/output.js";
import * as display from "../../../lib/tunnel/display.js";

let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); error.mockRestore(); });

it("isolates asynchronous output contexts and restores human mode", async () => {
  await Promise.all([1, 2].map((value) => withJsonOutput(async () => {
    await Promise.resolve();
    expect(isJsonMode()).toBe(true);
    jsonResult({ value });
    humanLog("must not appear");
    diagnostic("\x1b[31mwarning\x1b[0m");
    finishOutput();
    expect(outputCompleted()).toBe(true);
    finishOutput();
  })));
  expect(log.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0]))).sort((a: { value: number }, b: { value: number }) => a.value - b.value)).toEqual([{ value: 1 }, { value: 2 }]);
  expect(error.mock.calls).toEqual([['{"warnings":["warning"]}'], ['{"warnings":["warning"]}']]);
  expect(isJsonMode()).toBe(false);
  expect(jsonResult({})).toBe(false);
  humanLog("human"); diagnostic("diagnostic");
  expect(log).toHaveBeenLastCalledWith("human");
  expect(error).toHaveBeenLastCalledWith("diagnostic");
});

it("emits null and default acknowledgements, discards a result on failure", () => {
  withJsonOutput(() => { printJson(null); finishOutput(); });
  withJsonOutput(() => { finishOutput(); });
  withJsonOutput(() => { jsonResult({ removed: true }); finishOutput(1, "failed", { completed: 1 }); });
  expect(log.mock.calls).toEqual([["null"], ['{"success":true}']]);
  expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ error: { code: "failed", message: "Command failed.", exit_code: 1, details: { completed: 1 } } });
});

it("streams only listener status and forwarding metadata, with no final acknowledgement", () => {
  withJsonOutput(() => {
    display.startProgress();
    display.ready("http://localhost:3000/hook");
    display.event("subscription_created", 200);
    display.eventFailed("subscription_created", "ECONNREFUSED");
    display.warn("Reconnecting");
    streamRecord("stopped");
    finishOutput();
    streamRecord("late_event");
  });
  const records = log.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));
  expect(records.map((r: { type: string }) => r.type)).toEqual(["connecting", "ready", "forward_result", "forward_failed", "stopped"]);
  expect(records[2]).toMatchObject({ event_type: "subscription_created", http_status: 200 });
  expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ type: "warning", message: "Reconnecting" });
  for (const record of records) {
    expect(record).toHaveProperty("timestamp");
    expect(record).not.toHaveProperty("payload");
  }
});

it("collects listener failures into one structured error", () => {
  withJsonOutput(() => { display.error("Connection failed"); finishOutput(1, "listen_failed"); });
  expect(JSON.parse(String(error.mock.calls[0]![0])).error.message).toBe("Connection failed");
});
