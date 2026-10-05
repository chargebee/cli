import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
  error,
  event,
  eventFailed,
  ready,
  sanitizeEventType,
  startProgress,
  stopProgress,
  warn,
} from "../../../../lib/tunnel/display.js";
import { setStderrIsTTY } from "../../../../lib/test-support/_helpers.js";

afterEach(() => {
  stopProgress();
});

describe("listen display", () => {
  it("prints a ready line with the local URL only", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      ready("http://localhost:3000/webhook");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toBe(
        "> Ready! Forwarding events to http://localhost:3000/webhook (^C to quit)",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("prints incoming events without connection internals", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      event("subscription_created", 200);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toMatch(/subscription_created \u2192 200$/);
      expect(line).not.toContain("appsync");
      expect(line).not.toContain("/webhooks/");
    } finally {
      log.mockRestore();
    }
  });

  it("marks a non-2xx local response so it stands out from a success", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      event("subscription_created", 500);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toMatch(/subscription_created \u2192 500 \(non-2xx\)$/);
    } finally {
      log.mockRestore();
    }
  });

  it("prints a distinct line for a forward that never reached the local server", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      eventFailed("subscription_created", "ECONNREFUSED");
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toMatch(/subscription_created \u2192 failed: ECONNREFUSED$/);
    } finally {
      log.mockRestore();
    }
  });

  it("prints warnings and errors to stderr with the same > prefix", () => {
    const write = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      warn("Session keepalive failed");
      error("Forward failed: boom");
      expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
        "> Session keepalive failed\n",
        "> Forward failed: boom\n",
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it("prints a static startup line when stderr is not a terminal", () => {
    const restoreTty = setStderrIsTTY(false);
    const write = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      startProgress();
      startProgress("Connecting webhook tunnel");
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("> Initiating webhook tunnel...\n");
    } finally {
      write.mockRestore();
      restoreTty();
    }
  });

  it("animates a single TTY line and clears it before the ready line", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const write = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      startProgress();
      await Bun.sleep(450);
      ready("http://localhost:3000/webhook");
      const output = write.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("\r> Initiating webhook tunnel.");
      expect(output).toContain("\r\x1B[2K");
      expect(log).toHaveBeenCalledWith(
        "> Ready! Forwarding events to http://localhost:3000/webhook (^C to quit)",
      );
    } finally {
      log.mockRestore();
      write.mockRestore();
      if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });

  describe("sanitizeEventType", () => {
    it("strips control characters", () => {
      expect(sanitizeEventType("sub[31mscription_created\n")).toBe(
        "sub[31mscription_created",
      );
    });

    it("strips C1 control characters too", () => {
      expect(sanitizeEventType("sub\u009bscription\u0085created")).toBe("subscriptioncreated");
    });

    it("caps length at 64 characters", () => {
      const long = "a".repeat(100);
      expect(sanitizeEventType(long)).toHaveLength(64);
    });

    it("leaves a well-formed event type untouched", () => {
      expect(sanitizeEventType("subscription_created")).toBe("subscription_created");
    });
  });
});
