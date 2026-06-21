import { describe, it, expect } from "vitest";

import { ID_PREFIXES, prefixedId, isPrefixedId, formatId, parseId } from "./ids.js";

const VALID_ULID = "01J9Z3K8Q0X4M7P2R5T6V8W9Y0"; // 26 Crockford base32 chars

describe("prefixed ULID helpers", () => {
  describe("prefixedId().parse", () => {
    it("accepts a well-formed prefixed ULID", () => {
      const id = `lst_${VALID_ULID}`;
      expect(prefixedId("lst").parse(id)).toBe(id);
    });

    it("rejects the wrong prefix", () => {
      expect(prefixedId("ord").safeParse(`lst_${VALID_ULID}`).success).toBe(false);
    });

    it("rejects a ULID containing excluded Crockford letters (I, L, O, U)", () => {
      const bad = `lst_01J9Z3K8Q0X4M7P2R5T6V8W9YI`; // ends in I
      expect(prefixedId("lst").safeParse(bad).success).toBe(false);
    });

    it("rejects a too-short body", () => {
      expect(prefixedId("lst").safeParse("lst_01J9Z3K8Q0").success).toBe(false);
    });

    it("rejects a missing underscore", () => {
      expect(prefixedId("lst").safeParse(`lst${VALID_ULID}`).success).toBe(false);
    });

    it("rejects lowercase body chars", () => {
      expect(prefixedId("lst").safeParse(`lst_${VALID_ULID.toLowerCase()}`).success).toBe(false);
    });
  });

  describe("isPrefixedId", () => {
    it("is true for a valid id and narrows the type", () => {
      const value: unknown = `gen_${VALID_ULID}`;
      expect(isPrefixedId("gen", value)).toBe(true);
    });
    it("is false for non-strings and bad ids", () => {
      expect(isPrefixedId("gen", 123)).toBe(false);
      expect(isPrefixedId("gen", `ord_${VALID_ULID}`)).toBe(false);
    });
  });

  describe("formatId / parseId round-trip", () => {
    it("formats and parses back to the same parts", () => {
      const id = formatId(ID_PREFIXES.listing, VALID_ULID);
      expect(id).toBe(`lst_${VALID_ULID}`);
      expect(parseId(id)).toEqual({ prefix: "lst", ulid: VALID_ULID });
    });

    it("formatId throws on an invalid ULID body", () => {
      expect(() => formatId("lst", "nope")).toThrow();
    });

    it("parseId returns null for malformed input", () => {
      expect(parseId("nounderscore")).toBeNull();
      expect(parseId("lst_short")).toBeNull();
      expect(parseId("_" + VALID_ULID)).toBeNull();
    });
  });
});
