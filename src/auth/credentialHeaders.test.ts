import { describe, it, expect } from "vitest";
import { readCredentialHeaders } from "./credentialHeaders.js";
import { McpError } from "../utils/errors.js";

const complete = {
  "x-azure-tenant-id": "a82caf47-3509-4c3c-a665-276ad0921704",
  "x-azure-client-id": "11111111-2222-3333-4444-555555555555",
  "x-azure-client-secret": "a-secret-value",
};

describe("readCredentialHeaders", () => {
  it("returns null when no credential headers are present", () => {
    expect(readCredentialHeaders({})).toBeNull();
  });

  it("returns null when only unrelated headers are present", () => {
    expect(readCredentialHeaders({ authorization: "Bearer abc" })).toBeNull();
  });

  it("parses a complete credential set", () => {
    expect(readCredentialHeaders(complete)).toEqual({
      tenantId: complete["x-azure-tenant-id"],
      clientId: complete["x-azure-client-id"],
      clientSecret: complete["x-azure-client-secret"],
    });
  });

  it("trims header values", () => {
    const parsed = readCredentialHeaders({
      ...complete,
      "x-azure-client-id": "  spaced-client-id  ",
    });
    expect(parsed?.clientId).toBe("spaced-client-id");
  });

  it("takes the first value when a header is repeated", () => {
    const parsed = readCredentialHeaders({
      ...complete,
      "x-azure-tenant-id": ["first-tenant", "second-tenant"],
    });
    expect(parsed?.tenantId).toBe("first-tenant");
  });

  it("throws when the credential set is partial", () => {
    expect(() =>
      readCredentialHeaders({
        "x-azure-tenant-id": complete["x-azure-tenant-id"],
        "x-azure-client-id": complete["x-azure-client-id"],
      })
    ).toThrow(McpError);
  });

  it("names the missing headers in the error", () => {
    expect(() => readCredentialHeaders({ "x-azure-tenant-id": "t" })).toThrow(
      /X-Azure-Client-Id, X-Azure-Client-Secret/
    );
  });

  it("treats a whitespace-only value as missing", () => {
    expect(() => readCredentialHeaders({ ...complete, "x-azure-client-secret": "   " })).toThrow(
      /X-Azure-Client-Secret/
    );
  });
});
