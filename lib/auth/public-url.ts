/**
 * Next.js standalone builds `request.url` from the server's own HOSTNAME:PORT
 * (0.0.0.0:3000 in the container), ignoring the Host header. Redirects built
 * from it sent users to https://0.0.0.0:3000/login behind the Cloudflare tunnel.
 *
 * The public origin comes from the Host header only when it is one of our own
 * hosts (NEXT_PUBLIC_BASE_URL plus the comma-separated PUBLIC_HOSTS); any other
 * Host falls back to NEXT_PUBLIC_BASE_URL, so a forged Host cannot steer a redirect.
 */
const configuredHosts = (): { primary: URL | null; hosts: Set<string> } => {
  let primary: URL | null = null;
  try {
    if (process.env.NEXT_PUBLIC_BASE_URL) {
      primary = new URL(process.env.NEXT_PUBLIC_BASE_URL);
    }
  } catch {
    primary = null;
  }
  const hosts = new Set(
    (process.env.PUBLIC_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (primary) hosts.add(primary.host.toLowerCase());
  return { primary, hosts };
};

export function publicUrl(path: string, request: Request): URL {
  const base = new URL(request.url);
  // Only the container-internal origin is wrong; local dev and Vercel already
  // see the real one, so leave those untouched.
  if (base.hostname !== "0.0.0.0") return new URL(path, base);

  const { primary, hosts } = configuredHosts();
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (host && hosts.has(host)) {
    return new URL(path, `https://${host}`);
  }
  return new URL(path, primary ?? base);
}
