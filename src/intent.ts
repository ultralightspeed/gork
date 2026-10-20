// Whether the asker's own message says "everyone", which @everyone needs (with the MENTIONS setting and the asker's
// Mention Everyone). A word check, not grammar, so any phrasing works. Events and polls need only the permission, on
// both sides (discord-access.ts).

// The words, as whole words; @everyone and @here as Discord reads them (not inside an address like bob@here.com).
const EVERYONE_WORDS = /(?<![\p{L}\p{N}_])(?:@?everyone|everybody|@here|announce\w*)(?![\p{L}\p{N}_])/iu;

/** The asker's message mentions everyone, everybody, @everyone, @here or announcing something. */
export function mentionsEveryone(text: string): boolean {
  return EVERYONE_WORDS.test(text);
}
