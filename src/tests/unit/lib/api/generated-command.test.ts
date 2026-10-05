import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";

import { assertResourceId, handleCodeSample } from "../../../../lib/api/generated-command.js";

describe("handleCodeSample", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  it("exits when neither catalog maps this operation to an operationId", async () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit 1");
    }) as never);

    await expect(
      handleCodeSample({
        lang: "curl",
        opIdV2: "",
        opIdV1: "",
        method: "GET",
        uri: "/customers",
        dataFlags: [],
        pcVersionFlag: "v2",
      }),
    ).rejects.toThrow(/exit 1/);

    expect(errorSpy.mock.calls[0]?.[0]).toContain("not available for this operation");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("assertResourceId", () => {
  it("rejects path-like ids via command.error", () => {
    const cmd = new Command();
    cmd.exitOverride();
    expect(() => assertResourceId("../x", cmd)).toThrow(/invalid id/);
  });
});
