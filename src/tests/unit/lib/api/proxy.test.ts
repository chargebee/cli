import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { __resetProxyHint, maybeWarnUnproxiedNode } from "../../../../lib/api/proxy.js";

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** `process.versions` is readonly in the type declarations but writable at runtime. */
function setVersions(v: NodeJS.ProcessVersions): void {
  (process as { versions: NodeJS.ProcessVersions }).versions = v;
}

describe("maybeWarnUnproxiedNode", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let stderrSpy: ReturnType<typeof spyOn>;
  const savedVersions = process.versions;

  beforeEach(() => {
    for (const k of PROXY_KEYS) savedEnv[k] = process.env[k];
    for (const k of PROXY_KEYS) delete process.env[k];
    savedEnv.NODE_OPTIONS = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    savedEnv.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY;
    delete process.env.NODE_USE_ENV_PROXY;
    // Simulate the npm/Node build: `process.versions.bun` is undefined there.
    setVersions({ ...savedVersions, bun: undefined } as unknown as NodeJS.ProcessVersions);
    __resetProxyHint();
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    for (const k of PROXY_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedEnv.NODE_OPTIONS;
    if (savedEnv.NODE_USE_ENV_PROXY === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = savedEnv.NODE_USE_ENV_PROXY;
    setVersions(savedVersions);
    __resetProxyHint();
    stderrSpy.mockRestore();
  });

  it("does nothing when no proxy env var is set", () => {
    maybeWarnUnproxiedNode();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warns once under Node when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    maybeWarnUnproxiedNode();
    maybeWarnUnproxiedNode();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]?.[0] as string).toContain("HTTPS_PROXY");
    expect(stderrSpy.mock.calls[0]?.[0] as string).toContain("NODE_USE_ENV_PROXY=1");
  });

  it("does not warn under the Bun runtime", () => {
    setVersions(savedVersions); // restore the real (Bun) versions object
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    maybeWarnUnproxiedNode();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not warn when --use-env-proxy is already active via NODE_OPTIONS", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NODE_OPTIONS = "--use-env-proxy";
    maybeWarnUnproxiedNode();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not warn when NODE_USE_ENV_PROXY=1 is set", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NODE_USE_ENV_PROXY = "1";
    maybeWarnUnproxiedNode();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("still warns for NODE_USE_ENV_PROXY values Node ignores", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NODE_USE_ENV_PROXY = "true";
    maybeWarnUnproxiedNode();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn when --use-env-proxy is already on process.execArgv", () => {
    const orig = process.execArgv;
    Object.defineProperty(process, "execArgv", {
      value: ["--use-env-proxy"],
      configurable: true,
    });
    try {
      process.env.HTTPS_PROXY = "http://proxy.example:8080";
      maybeWarnUnproxiedNode();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "execArgv", { value: orig, configurable: true });
    }
  });
});
