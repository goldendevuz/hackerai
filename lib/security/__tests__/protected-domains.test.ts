import { describe, expect, it } from "@jest/globals";
import {
  allowEntryCoversProtectedHost,
  findProtectedHost,
  isProtectedHost,
} from "../protected-domains";
import { normalizeNetworkPolicy } from "@/lib/cloud-network/policy";

describe("protected domains", () => {
  it("covers the apex and every subdomain depth, case-insensitively", () => {
    expect(isProtectedHost("solider.uz")).toBe(true);
    expect(isProtectedHost("API.Admin.Solider.uz.")).toBe(true);
    expect(isProtectedHost("notsolider.uz")).toBe(false);
    expect(isProtectedHost("solider.uz.evil.com")).toBe(false);
  });

  it("finds hosts inside commands, URLs and encoded input", () => {
    expect(findProtectedHost("nmap -sV -p- mail.goldendev.uz")).toBe(
      "mail.goldendev.uz",
    );
    expect(findProtectedHost("curl https://top3.uz:8443/admin")).toBe(
      "top3.uz",
    );
    expect(findProtectedHost("curl http%3A%2F%2Fapi.tiki.uz%2F")).toContain(
      "tiki.uz",
    );
    expect(findProtectedHost("curl https://portswigger.net")).toBeNull();
    expect(findProtectedHost("echo notsolider.uz big-top3.uz")).toBeNull();
  });

  it("rejects allowlist entries that reach a protected host", () => {
    expect(allowEntryCoversProtectedHost("*.uz")).toBe(true);
    expect(allowEntryCoversProtectedHost("*.solider.uz")).toBe(true);
    expect(allowEntryCoversProtectedHost("portswigger.net")).toBe(false);
    for (const entry of ["solider.uz", "*.uz", "api.top3.uz"]) {
      expect(() =>
        normalizeNetworkPolicy({ mode: "restricted", allow: [entry] }),
      ).toThrow("HackerAI operator");
    }
  });
});
