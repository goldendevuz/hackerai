import { z } from "zod";

export const networkPolicySchema = z
  .object({
    mode: z.enum(["unrestricted", "restricted", "offline"]),
    allow: z.array(z.string().max(253)).max(100),
  })
  .strict();
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  mode: "unrestricted",
  allow: [],
};

/**
 * Solider.uz change: platform default when a user has no saved network
 * policy yet. Upstream falls back to DEFAULT_NETWORK_POLICY ("unrestricted")
 * in that case, so a fresh sandbox has full internet access until someone
 * opts into a restriction via Settings. For a labs-only product we want the
 * opposite starting point: restricted to the one lab platform that needs no
 * VPN (PortSwigger Web Security Academy) until the user's own policy (set
 * through the existing CloudNetworkSettings UI / saveNetworkSettings, e.g.
 * once a personal HackTheBox/TryHackMe VPN endpoint is added to `allow`)
 * takes over. A user who has explicitly saved a policy of their own --
 * "unrestricted" included -- is never affected; this only changes what a
 * brand-new, never-configured account gets by default.
 *
 * Also allows the R2 upload domain: get_terminal_files and other generated-
 * file delivery run `curl -X PUT <presigned-url>` *inside the sandbox*
 * (see lib/ai/tools/utils/sandbox-file-uploader.ts), so that upload is
 * subject to this same policy. Without it, every file a restricted-default
 * sandbox tries to hand back to the user (reports, screenshots, PoCs) fails
 * with a TLS handshake error indistinguishable from a real network problem
 * -- discovered the hard way when an agent-generated PDF report silently
 * failed to upload. Convex itself isn't a sandbox curl target, so it needs
 * no entry here. (An AWS S3 deployment, STORAGE_PROVIDER unset, would need
 * its bucket's `*.amazonaws.com` host here instead -- out of scope for this
 * R2-only fork.)
 */
export const SOLIDER_LAB_DEFAULT_POLICY: NetworkPolicy = {
  mode: "restricted",
  allow: [
    "portswigger.net",
    // E2B's allowOut matches a bare domain exactly, not its subdomains
    // (see node_modules/e2b SandboxNetworkConfig docs), so login and the
    // lab platform's other subdomains need their own wildcard entry.
    "*.portswigger.net",
    "*.web-security-academy.net",
    // Official Web Security Academy exploit/collaborator server, used by
    // most JWT/SSRF/CSRF/XSS labs to host an attacker-controlled JWKS,
    // redirect target, or callback -- not a third-party domain.
    "exploit-server.net",
    "*.exploit-server.net",
    "*.r2.cloudflarestorage.com",
    // DoD Vulnerability Disclosure Program: authorized passive recon target.
    "defense.gov",
    "*.defense.gov",
    "*.mil",
    // GitLab bug bounty: cloning in-scope source repos and building them
    // (gitlab-shell, gitlab-pages, etc. are Go modules, so `go build` needs
    // the module proxy too).
    "gitlab.com",
    "*.gitlab.com",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "proxy.golang.org",
    "sum.golang.org",
    "*.storage.googleapis.com",
  ],
};

function networkHost(value: string): string {
  try {
    if (!value || /[\s/@?#\\%:]/.test(value)) throw new Error("Invalid host");
    const wildcard = value.startsWith("*.");
    const rawHost = wildcard ? value.slice(2) : value;
    const normalized = new URL(`https://${rawHost}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    if (
      !normalized ||
      !normalized
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      (/^\d+\.\d+\.\d+\.\d+$/.test(normalized) &&
        rawHost.replace(/\.$/, "") !== normalized) ||
      (wildcard && /^[\d.]+$/.test(normalized))
    )
      throw new Error("Invalid host");
    return wildcard ? `*.${normalized}` : normalized;
  } catch {
    throw new Error(
      "Use a valid hostname, wildcard, IPv4 address, or IPv4 CIDR. URLs and ports are not supported.",
    );
  }
}
export function normalizeNetworkPolicy(input: unknown): NetworkPolicy {
  const parsed = networkPolicySchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Choose a network mode and use at most 100 destinations of up to 253 characters each.",
    );
  const policy = parsed.data;
  const allow = [
    ...new Set(
      policy.allow.map((entry) => {
        const value = entry.trim();
        // CIDRs here are IPv4 only. Never resolve a hostname into a shared-IP grant.
        if (value.includes("/")) {
          const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(value);
          if (
            !match ||
            Number(match[2]) > 32 ||
            String(Number(match[2])) !== match[2]
          )
            throw new Error(
              "Use a hostname, wildcard, IPv4 address, or IPv4 CIDR. URLs and ports are not supported.",
            );
          if (networkHost(match[1]) !== match[1])
            throw new Error("Use a canonical IPv4 address.");
          return value;
        }
        const host = networkHost(value);
        if (host.includes(":") || host.startsWith("["))
          throw new Error("IPv6 is not supported by this setting.");
        return host;
      }),
    ),
  ].sort();
  if (policy.mode === "restricted" && !allow.length)
    throw new Error("Add an allowed destination or choose No internet.");
  return {
    mode: policy.mode,
    allow: policy.mode === "restricted" ? allow : [],
  };
}

export function e2bNetwork(policy: NetworkPolicy) {
  return {
    allowOut: policy.mode === "restricted" ? policy.allow : [],
    denyOut: policy.mode === "unrestricted" ? [] : ["0.0.0.0/0"],
  };
}

export type NetworkSettings = {
  policy: NetworkPolicy;
  revision: number;
  status: "ready" | "applying" | "failed";
};
