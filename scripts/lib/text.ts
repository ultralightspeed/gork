import { withoutSecrets } from "../../src/cf.ts";
import { isInvisible } from "../../src/context.ts";

/**
 * A response's JSON with every copy of the request's own credential taken out first, or {} when it isn't JSON. A
 * server may echo the Authorization header in an error, and the callers quote cut-off excerpts of errors: a token cut
 * in two would get past any later redaction, so it goes before anything reads the body.
 */
export async function jsonWithout(res: Response, credential: string): Promise<unknown> {
  const text = withoutSecrets(await res.text().catch(() => ""), credential);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** C0 and C1 controls and DEL; invisible and bidi characters come from the bot's own list (isInvisible). */
function unsafe(ch: string): boolean {
  const code = ch.codePointAt(0) as number;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isInvisible(ch);
}

/** Text from outside (server names, app names) made safe to print: control and invisible characters removed, length capped. */
export function printable(text: string, max = 60): string {
  return [...text]
    .filter((ch) => !unsafe(ch))
    .join("")
    .slice(0, max);
}
