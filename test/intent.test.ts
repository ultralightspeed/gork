import { describe, expect, it } from "vitest";
import { mentionsEveryone } from "../src/intent.ts";

describe("mentionsEveryone", () => {
  // Every phrasing typed in the test server, then other natural ones. A word check: no grammar to fall through.
  it.each([
    "do it, and also tag everyone and tell the date",
    "do it and tag everyone",
    "try tagging everyone again",
    "ping everyone",
    "@everyone raid in 10",
    "@here anyone up?",
    "tag everybody",
    "let everyone know the raid moved to 9",
    "announce the patch",
    "make an announcement: servers down tonight",
    "can you please notify everyone",
    "Everyone needs to see this",
    "yo gork, EVERYONE should know",
    "remind everyone about friday",
    "everyone?",
    "tell everyone, then make the event",
    "<@&123> and everyone else",
  ])("says everyone: %s", (text) => expect(mentionsEveryone(text)).toBe(true));

  it.each([
    "make me a poll on pizza vs tacos",
    "schedule a raid friday 8pm",
    "do it",
    "what's the capital of australia",
    "email me at bob@here.com",
    "nobody here?",
    "everyoneelse is a word I made up",
    "",
  ])("doesn't: %s", (text) => expect(mentionsEveryone(text)).toBe(false));
});
