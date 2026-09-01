import { describe, it, expect } from "vitest";
import {
  checkSharedSecret,
  getConfiguredSecret,
  SHARED_SECRET_ENV,
  SHARED_SECRET_HEADER,
} from "./sharedSecret.js";

const env = (secret?: string): NodeJS.ProcessEnv =>
  secret === undefined ? {} : { [SHARED_SECRET_ENV]: secret };

describe("sharedSecret", () => {
  describe("getConfiguredSecret", () => {
    it("returns null when unset", () => {
      expect(getConfiguredSecret(env())).toBeNull();
    });

    it("returns null when set to whitespace", () => {
      expect(getConfiguredSecret(env("   "))).toBeNull();
    });

    it("trims the configured value", () => {
      expect(getConfiguredSecret(env("  hunter2  "))).toBe("hunter2");
    });
  });

  describe("checkSharedSecret", () => {
    it("allows everything when no secret is configured", () => {
      const result = checkSharedSecret({}, env());
      expect(result).toEqual({ allowed: true, reason: "disabled" });
    });

    it("rejects a request with no header when a secret is configured", () => {
      const result = checkSharedSecret({}, env("hunter2"));
      expect(result).toEqual({ allowed: false, reason: "missing" });
    });

    it("rejects a wrong secret", () => {
      const result = checkSharedSecret({ [SHARED_SECRET_HEADER]: "nope" }, env("hunter2"));
      expect(result).toEqual({ allowed: false, reason: "mismatch" });
    });

    it("rejects a wrong secret of a different length without throwing", () => {
      const result = checkSharedSecret(
        { [SHARED_SECRET_HEADER]: "a-much-longer-guess-entirely" },
        env("hunter2")
      );
      expect(result).toEqual({ allowed: false, reason: "mismatch" });
    });

    it("allows a matching secret", () => {
      const result = checkSharedSecret({ [SHARED_SECRET_HEADER]: "hunter2" }, env("hunter2"));
      expect(result).toEqual({ allowed: true, reason: "matched" });
    });

    it("tolerates surrounding whitespace on the header value", () => {
      const result = checkSharedSecret({ [SHARED_SECRET_HEADER]: " hunter2 " }, env("hunter2"));
      expect(result.allowed).toBe(true);
    });

    it("uses the first value when the header is repeated", () => {
      const result = checkSharedSecret(
        { [SHARED_SECRET_HEADER]: ["hunter2", "nope"] },
        env("hunter2")
      );
      expect(result.allowed).toBe(true);
    });
  });
});
