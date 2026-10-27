// Root certificates gork refuses to trust, whatever the trust store it runs with says. Node ignores revocation, so a
// root stays trusted until Node itself ships without it; this list closes that gap for the tokens gork sends.
//
// October 2026: the private keys of eight eMudhra intermediate CAs were compromised
// (https://emudhra.we-have-a-problem.com/). They chain to these roots, directly or through cross-signs. Discord,
// Cloudflare and YouTube use none of them. Node 24.22.1 and Alpine's later CA bundle ship without all four, so in the
// image this is a backstop; the host scripts still need it, since they run on whatever Node the user has installed.
// Only node: imports here: the Dockerfile runs this file to filter the certificate bundle ffmpeg reads.
import { X509Certificate } from "node:crypto";
import tls from "node:tls";

/** SHA-256 fingerprint (upper-case hex, no colons) to the root's name. */
export const DISTRUSTED_ROOTS: ReadonlyMap<string, string> = new Map([
  ["86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B", "emSign ECC Root CA - G3"],
  ["7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D", "emSign Root TLS CA - G3"],
  ["F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5", "emSign Root CS CA - G3"],
  ["D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4", "AAA Certificate Services"],
]);

/** A PEM certificate's SHA-256 fingerprint, as DISTRUSTED_ROOTS writes it. */
export const fingerprint = (pem: string): string => new X509Certificate(pem).fingerprint256.replaceAll(":", "");

/** The certificates, less the distrusted roots. */
export function withoutDistrusted(pems: readonly string[]): string[] {
  return pems.filter((p) => !DISTRUSTED_ROOTS.has(fingerprint(p)));
}

/** The part of node:tls used here; setDefaultCACertificates is missing before Node 24.5. */
type TrustStore = {
  getCACertificates(type: "default"): string[];
  setDefaultCACertificates?(certs: string[]): void;
};

/**
 * Takes the distrusted roots out of this process's default trust store, which fetch, discord.js and every other TLS
 * connection use. Returns how many it removed, or null on a Node too old to replace the store (before 24.5).
 */
export function distrustRoots(store: TrustStore = tls): number | null {
  if (typeof store.setDefaultCACertificates !== "function") return null;
  const all = store.getCACertificates("default");
  const kept = withoutDistrusted(all);
  store.setDefaultCACertificates(kept);
  return all.length - kept.length;
}

/** What the host scripts print when distrustRoots returns null. */
export const OLD_NODE_WARNING =
  "warning: this Node can't drop the distrusted root certificates listed in src/distrust.ts; update Node to 24.5 or newer.";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/g;

/** A PEM bundle file's text with the distrusted roots cut out; everything else is kept as it was. */
export function filterBundle(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(PEM_BLOCK, (block) => {
    if (!DISTRUSTED_ROOTS.has(fingerprint(block))) return block;
    removed++;
    return "";
  });
  return { text: out, removed };
}
