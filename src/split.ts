function bestCut(s: string, room: number): number {
  for (const sep of ["\n", " "]) {
    const i = s.lastIndexOf(sep, room);
    if (i > room * 0.5) return i;
  }
  return room;
}

function fenceOpener(chunk: string): string {
  const lines = chunk.split("\n").filter((l) => l.trimStart().startsWith("```"));
  return lines.at(-1)?.trim() ?? "```";
}

/** Splits text into Discord-sized chunks, preferring line breaks and keeping code fences balanced. */
export function splitMessage(text: string, max = 1900, maxChunks = 4): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let reopen = "";
  while (rest.length > 0 && chunks.length < maxChunks) {
    const prefix = reopen ? `${reopen}\n` : "";
    const room = max - prefix.length - 4;
    const cut = rest.length <= room ? rest.length : bestCut(rest, room);
    let chunk = prefix + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\s+/, "");
    const open = (chunk.match(/```/g) ?? []).length % 2 === 1;
    reopen = open ? fenceOpener(chunk) : "";
    if (open && rest.length > 0) chunk += "\n```";
    chunks.push(chunk);
  }
  if (rest.length > 0) {
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = `${last.slice(0, max - 12)}\n…(trimmed)`;
  }
  return chunks.length ? chunks : [""];
}
