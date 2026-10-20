# Personalities

A personality is a short text file in `personas/`. It sets how gork talks. It never overrides accuracy, and it cannot change the safety rules. Set `PERSONA` in `.env`, then run `npm run up`.

| `PERSONA=` | Style |
|---|---|
| `default` | Terse and a little trolly, talks like a Discord regular, always answers first. |
| `witty` | Dry, sarcastic banter that roasts ideas, not people. |
| `hype` | Upbeat gamer-friend energy. |
| `noir` | A 1940s private eye narrating every reply. |
| `professor` | A patient teacher with everyday analogies. The calmest choice for a formal server. |

## Writing your own in the setup page

In step 1 of `npm run setup`, choose custom. An editor opens with these fields:

- Name: what gork calls itself (up to 32 characters: letters, numbers, spaces and `- _ . '`).
- How should gork talk and behave?: the personality itself, up to 8,000 characters. Write `{name}` where gork's name should go. It starts from the example file, and the page accepts it only after you replace the `[bracketed parts]` of the example.
- Quirk and how often (0 to 100 percent): an optional extra instruction used on some replies.
- Advanced, fixed replies: your own wording for the fixed lines (busy, cooldown, error and so on). Leave a box empty to keep gork's own wording.

If you already have a `personas/custom.md`, the editor starts from it and says that saving replaces it. The page writes `personas/custom.md` when you press **Continue** in step 1, even if you stop setup later, and writes nothing else. It sets `PERSONA=custom` in `.env` for you. Anything in an existing file that the editor has no field for (comments, `description`, unknown keys) is not kept.

## Writing your own by hand

1. Copy `personas/custom.example.md` to `personas/custom.md`.
2. Edit it. Replace every `[bracketed placeholder]`.
3. Set `PERSONA=custom` in `.env`.
4. Run `npm run up`.

gork reads the file when it starts. After you edit it later, run `npm run up` again, and it restarts gork when the persona file has changed.

`personas/custom.md` is ignored by git, so git never commits it. You can also save any file as `personas/<name>.md` and set `PERSONA=<name>`.

## The file format

A persona file has two parts. At the top is a block between two `---` lines, with one `key: value` per line. Lines starting with `#` are comments. Below it is the text sent to the model: who gork is and how it talks. All the keys are optional.

| Key | What it does |
|---|---|
| `name` | The bot's name. `{name}` in the text becomes this. Default `gork`. |
| `description` | One line about the personality. |
| `quirk` | One extra instruction added to some replies, for a recurring bit. |
| `quirk_rate` | The share of replies that get the quirk, from 0 to 1. |
| `reply.busy` | Sent when gork is still answering the last question. |
| `reply.cooldown` | Sent when someone asks too soon. `{seconds}` becomes the wait. |
| `reply.empty` | Sent when someone mentions gork with no question. |
| `reply.error` | Sent when something breaks. |
| `reply.out_of_budget` | Sent when the daily budget is used up. |
| `reply.blocked` | Sent when a request is refused. |
| `reply.empty_answer` | Sent when the model returns no text. |
| `reply.no_attach` | Added when an image was made but can't be posted in that channel. |
| `reply.no_poll` | Added when a poll was made but can't be posted in that channel. |
| `reply.no_event` | Added when an event was made but the person asking, or gork, cannot create events on the server. |
| `reply.event_failed` | Sent when Discord refused to create the event. |

Unknown keys are ignored and noted in the startup log. The self-harm reply, the "safety check is down" reply and the notes about a blocked image are fixed in code. A persona cannot change them.
