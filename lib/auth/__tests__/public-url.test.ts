import { afterEach, describe, expect, it } from "@jest/globals";
import { publicUrl } from "../public-url";

const request = (host: string | null, url = "http://0.0.0.0:3000/callback") =>
  ({
    url,
    headers: { get: (name: string) => (name === "host" ? host : null) },
  }) as unknown as Request;

describe("publicUrl", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("replaces the container-internal origin with the public host", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://solider.univel.uz";
    process.env.PUBLIC_HOSTS = "solider.uz";
    expect(publicUrl("/login", request("solider.uz")).href).toBe(
      "https://solider.uz/login",
    );
    expect(publicUrl("/login", request("solider.univel.uz")).href).toBe(
      "https://solider.univel.uz/login",
    );
  });

  it("ignores a Host that is not ours and uses the configured base URL", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://solider.univel.uz";
    expect(publicUrl("/login", request("evil.example")).href).toBe(
      "https://solider.univel.uz/login",
    );
    expect(publicUrl("/login", request(null)).href).toBe(
      "https://solider.univel.uz/login",
    );
  });

  it("leaves an already-correct request origin alone", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://solider.univel.uz";
    expect(
      publicUrl("/x", request("evil.example", "http://localhost:3000/a")).href,
    ).toBe("http://localhost:3000/x");
  });
});
