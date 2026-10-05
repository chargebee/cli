import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REGION,
  REGIONS,
  invalidRegionMessage,
  parseRegion,
  regionLabel,
} from "../../../../lib/config/region.js";

describe("region", () => {
  it("defaults to us and offers exactly us, eu, au", () => {
    expect(DEFAULT_REGION).toBe("us");
    expect(REGIONS).toEqual(["us", "eu", "au"]);
  });

  it("parses every supported region", () => {
    for (const region of REGIONS) {
      expect(parseRegion(region)).toBe(region);
    }
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseRegion("  EU ")).toBe("eu");
    expect(parseRegion("Au")).toBe("au");
  });

  it("rejects anything that is not a supported region, including AWS region names", () => {
    for (const raw of ["", "  ", "usa", "us-east-1", "eu-central-1", "uk", "global"]) {
      expect(() => parseRegion(raw)).toThrow(/Invalid region/);
    }
  });

  it("names the accepted values in the error message", () => {
    const msg = invalidRegionMessage("uk");
    expect(msg).toContain('"uk"');
    expect(msg).toContain("us, eu, au");
  });

  it("has a human label for every region", () => {
    expect(regionLabel("us")).toBe("United States");
    expect(regionLabel("eu")).toBe("Europe");
    expect(regionLabel("au")).toBe("Australia");
  });
});
