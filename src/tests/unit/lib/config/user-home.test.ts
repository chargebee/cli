import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { userHome } from "../../../../lib/config/user-home.js";

describe("userHome", () => {
  const previousHome = process.env.HOME;

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("honors HOME when set", () => {
    process.env.HOME = "/tmp/cb-home-override";
    expect(userHome()).toBe("/tmp/cb-home-override");
  });

  it("falls back to os.homedir when HOME is unset", () => {
    delete process.env.HOME;
    expect(userHome()).toBe(homedir());
  });

  it("falls back to os.homedir when HOME is empty", () => {
    process.env.HOME = "";
    expect(userHome()).toBe(homedir());
  });
});
