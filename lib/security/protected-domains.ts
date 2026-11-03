/**
 * Domains owned by the HackerAI operator. The agent must never be used to scan,
 * probe or attack them, or any of their subdomains, whatever the user's network
 * policy or prompt says.
 *
 * E2B's `denyOut` accepts only IPs and CIDRs, so a hostname cannot be blocked
 * at the sandbox network layer (and resolving it into CIDRs would block shared
 * Cloudflare ranges). Enforcement is therefore split:
 *   - network policy: `assertPolicyAvoidsProtectedDomains` keeps these hosts out
 *     of a restricted allowlist, including wildcards that would cover them;
 *   - tools: `findProtectedHost` rejects terminal commands and URLs that name them.
 * Text matching cannot see a host built at runtime or reached by bare IP, so
 * this is a guard rail on the hosted deployment, not a security boundary.
 */
export const PROTECTED_DOMAINS: readonly string[] = [
  "abdulmajid.uz",
  "abdulmajidyunus.uz",
  "ahsanacademy.uz",
  "ai-academy.uz",
  "aiacademy.uz",
  "animedu.uz",
  "anivel.uz",
  "arkan.uz",
  "arzoncrm.uz",
  "avtotop.uz",
  "bloodteam.uz",
  "botsoft.uz",
  "bugbone.uz",
  "chessmind.uz",
  "dachadam.uz",
  "dazmol.uz",
  "dolingo.uz",
  "elera.uz",
  "eltir.uz",
  "fastbid.uz",
  "fleekapi.uz",
  "gazmol.uz",
  "goldendev.uz",
  "golingo.uz",
  "ho-re-ca.uz",
  "iacademy.uz",
  "istoma.uz",
  "jolingo.uz",
  "keynotex.uz",
  "ladder.uz",
  "large.uz",
  "launchspace.uz",
  "mussi.uz",
  "onebid.uz",
  "oneway.uz",
  "opendb.uz",
  "optmarket.uz",
  "ovation.uz",
  "puzzlepool.uz",
  "pylord.uz",
  "qora-qozon.uz",
  "qoraqozon.uz",
  "rabee.uz",
  "real-grammar.uz",
  "routy.uz",
  "rung.uz",
  "sarik.uz",
  "sauron.uz",
  "sauronuz.uz",
  "savetube.uz",
  "sevingo.uz",
  "shats.uz",
  "sinau.uz",
  "soldier.uz",
  "solider.uz",
  "stoma-shats.uz",
  "supernaf.uz",
  "templify.uz",
  "tezdukon.uz",
  "tiki.uz",
  "tilovoz.uz",
  "top3.uz",
  "umarcreates.uz",
  "unchess.uz",
  "unibiz.uz",
  "univel.uz",
  "ustuvor.uz",
  "vestro.uz",
  "vita-balans.uz",
  "wwc-studio.uz",
  "zerifmebel.uz",
];

export const PROTECTED_DOMAIN_ERROR =
  "This destination belongs to the HackerAI operator and is protected. The request was not run.";

const normalizeHost = (host: string) =>
  host.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");

/** True when `host` is a protected domain or any subdomain of one. */
export function isProtectedHost(host: string): boolean {
  const value = normalizeHost(host);
  return PROTECTED_DOMAINS.some(
    (domain) => value === domain || value.endsWith(`.${domain}`),
  );
}

/**
 * True when an allowlist entry would let traffic reach a protected host: the
 * host itself, a subdomain of it, or a wildcard on a parent such as `*.uz`.
 * CIDRs and IPs are not hostnames and are out of scope here.
 */
export function allowEntryCoversProtectedHost(entry: string): boolean {
  const value = entry.trim().toLowerCase();
  if (isProtectedHost(value)) return true;
  if (!value.startsWith("*.")) return false;
  const suffix = value.slice(2).replace(/\.$/, "");
  return PROTECTED_DOMAINS.some((domain) => domain.endsWith(`.${suffix}`));
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A hostname label char on the left means a different domain ("notsolider.uz"),
// so only a non-label char or the start of the text may precede the match.
const PROTECTED_PATTERN = new RegExp(
  `(?<![a-z0-9-])(?:[a-z0-9-]+\\.)*(?:${PROTECTED_DOMAINS.map(escapeRegExp).join("|")})(?![a-z0-9-])`,
  "i",
);

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Returns the protected host named in free text (a command, URL or input), if any. */
export function findProtectedHost(text: string): string | null {
  for (const candidate of [text, safeDecode(text)]) {
    const match = PROTECTED_PATTERN.exec(candidate);
    if (match) return match[0].toLowerCase();
  }
  return null;
}
