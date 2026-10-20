import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { DISTRUSTED_ROOTS, distrustRoots, filterBundle, fingerprint, withoutDistrusted } from "../src/distrust.ts";

// Node's own bundled Mozilla roots: emSign ECC Root CA - G3 is one of them, so it is a real root to remove.
const bundled = tls.getCACertificates("bundled");
const emSign = bundled.find((p) => new X509Certificate(p).subject.includes("CN=emSign ECC Root CA - G3"));

describe("roots gork refuses to trust", () => {
  it("lists the four roots above the compromised eMudhra intermediates (October 2026), by SHA-256", () => {
    expect([...DISTRUSTED_ROOTS.keys()].sort()).toEqual(
      [
        "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D",
        "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
        "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4",
        "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5",
      ].sort(),
    );
  });

  it("drops emSign ECC Root CA - G3 from Node's bundled roots and keeps every other root", () => {
    expect(emSign, "this Node's bundled store no longer has the root; the test needs another source").toBeDefined();
    expect(fingerprint(emSign as string)).toBe("86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B");
    const kept = withoutDistrusted(bundled);
    expect(kept).not.toContain(emSign);
    expect(kept.length).toBe(bundled.length - 1);
  });

  it("sets the process's default trust store without the distrusted roots, and says how many went", () => {
    let set: string[] | null = null;
    const fake = {
      getCACertificates: () => bundled,
      setDefaultCACertificates: (certs: string[]) => {
        set = certs;
      },
    };
    expect(distrustRoots(fake)).toBe(1);
    expect(set).not.toBeNull();
    expect(set).not.toContain(emSign);
  });

  it("returns null and changes nothing on a Node too old to replace the default trust store", () => {
    expect(distrustRoots({ getCACertificates: () => bundled })).toBeNull();
  });

  it("filters a PEM bundle file such as ffmpeg's, keeping the other certificates byte for byte", () => {
    const other = bundled.find((p) => p !== emSign) as string;
    const r = filterBundle(`# a comment line\n${other}\n${emSign}\n`);
    expect(r.removed).toBe(1);
    expect(r.text).toContain(other.trim());
    expect(r.text).not.toContain((emSign as string).trim());
  });
});

describe("where the distrusted roots are dropped", () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

  it("the bot, before it loads its settings or connects", () => {
    const main = read("src/index.ts").split("async function main(): Promise<void> {")[1];
    expect(main.indexOf("distrustRoots()")).toBeGreaterThan(-1);
    expect(main.indexOf("distrustRoots()")).toBeLessThan(main.indexOf("loadConfig()"));
  });

  it("every host script that sends a token: the CLI (setup, up, doctor...), probe and calibrate", () => {
    for (const f of ["scripts/gork.ts", "scripts/probe.ts", "scripts/calibrate.ts"])
      expect(read(f), f).toMatch(/distrustRoots\(\)/);
  });

  it("the image's CA bundle that ffmpeg reads: filtered through filterBundle, never copied as it is", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^COPY src\/distrust\.ts \/tmp\/distrust\.ts$/m);
    expect(dockerfile).toMatch(/filterBundle\(readFileSync\('\/etc\/ssl\/certs\/ca-certificates\.crt'/);
    expect(dockerfile).not.toMatch(/cp \S*ca-certificates\.crt/);
  });
});
