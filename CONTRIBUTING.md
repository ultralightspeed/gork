# Contributing to gork

This page covers how to set up, what to run before you open a pull request, and how to add a setting, a tool or a personality.

For what gork is and how to run it, read the [README](README.md).

## Set up

You need Node.js 24 or newer. The repository pins the major version in `.nvmrc`.

```sh
git clone <your fork>
cd gork
npm install
npm run check
```

You do not need Docker, a Discord token or a Cloudflare account to work on the code or run the tests. Docker is only for running the finished bot.

## Before you open a pull request

Run this from the project folder.

```sh
npm run check
```

It runs four things in order, and stops at the first failure:

1. `npm run typecheck` runs the TypeScript compiler (`tsc`) without writing files.
2. `npm run lint` runs Biome's linter and format check.
3. `npm run check-secrets` fails if a tracked file looks like it holds a token, or if a `.env` file is tracked.
4. `npm test` runs the tests with Vitest.

`npm run format` fixes formatting and import order for you.

Keep each pull request to one change, and say what it changes and why.

## Style

- The code is TypeScript that Node runs directly, using type stripping. There is no build step.
- Imports end in `.ts`, for example `import { loadConfig } from "./config.ts"`. Use `import type` for types.
- The compiler has `erasableSyntaxOnly` on, so there is no `enum`, no `namespace` and no constructor parameter properties. Write plain classes and unions instead.
- Biome formats the code: two spaces, a 120 column line, double quotes and trailing commas. Run `npm run format`.
- Comments say why, not what. Keep them short.
- Error messages may give a setting's name but must not print its value.
- Prefer a short function with a clear name over a clever one. Do not add a dependency for something a few lines can do.

## Tests

Tests are in `test/` and run with Vitest. They make no live calls: no test talks to Discord, Cloudflare, YouTube or Docker.

Use the fakes in `test/helpers.ts`:

- `testConfig()` builds a valid config. Pass environment overrides as strings, the way `.env` does.
- `fakeFetch(route)` stands in for `fetch`. It records each call and answers with your `route`. `json(...)` builds a response.
- `callTool(cfg, name, args)` runs one model tool call with fresh state.
- `fakeDocker(route)` stands in for the container engine (Docker or Podman). It records each call's arguments, and in `options` the compose files and environment each was run with.
- `fakeClock()` is a clock where sleeping just moves time forward.

Code that calls outside services takes `fetch` (or a runner) as an argument, so a test can swap it. Follow that pattern in new code.

`npm run probe` is different. It is a manual check of the live APIs, using your own token. Run it by hand when you change how gork talks to an outside service. It is not part of `npm test`.

`npm run calibrate` is also manual and live. It sends a few fixed requests (game talk, news questions and two that must be blocked) through the safety screen exactly as the bot does, prints each verdict, with the score for the blocked ones, and exits with an error on any unexpected verdict. It reads your full `.env`. Run it when you change the safety screen's questions or its threshold. The expected verdicts assume the default `GUARD_BLOCK`.

## Add a setting

Every setting is one row in the `SETTINGS` table in `src/config.ts`. That table is the single source of truth. The bot, the CLI, `.env.example` and the compose check all read from it.

1. Add a row to `SETTINGS`. Set its `group`, a `default`, a one-line `help` and a `parse` function. The parser returns the value or throws an `Error` that says what is wrong, without the key. Use the helpers there, such as `wholeNumber`, `nonNegative` and `oneOf`.
   - Add `required: true` if the user must set it. Add `secret: true` if it is a secret.
   - Leave `scope` off if the bot reads it. Use `scope: "host"` if only the CLI reads it and it must never enter the container. Use `scope: "image"` if the Dockerfile fixes it.
2. If the bot reads it, add it to the `Config` type and to `loadConfig` in the same file.
3. If the container reads it (no `scope`), add a line to the `environment:` block in `compose.yaml`: `KEY: ${KEY:-}`. Required keys use `${KEY}` with no default.
4. Regenerate the example file:

   ```sh
   node scripts/env-example.ts
   ```

   Commit the new `.env.example`. Do not edit it by hand.
5. Add a test for the parser or the behavior.
6. If the README or a page in `docs/` describes the behavior it changes, update that too.

`test/env-sync.test.ts` fails if `.env.example` or `compose.yaml` drift from the table. If it fails, you missed step 3 or 4.

## Add a tool

The model's tools are listed in one place: the array returned by `allTools` in `src/tools.ts`. A tool's definition and its code are in one entry. `toolsFor` only filters that array (for example, it drops `web_search` in free mode), and the model sees what is left.

1. Add an entry to the array. It has two parts:
   - `def`: build it with the `fn(name, description, properties, required)` helper. The description is what the model reads, so say when to use the tool and when not to. Put numbers from the constants that enforce them into the text, so the two cannot disagree.
   - `run(args, ctx)`: does the work and returns `{ content, costUsd }`. `content` is the text the model sees. Set `costUsd` to what the call cost, or `0`.
2. Check the arguments. Models send bad input. Return a short message saying what was wrong. The `asString` helper is there for this.
3. Treat everything the tool fetches as untrusted. Do not let it act as an instruction. Look at how `web_search` cleans its snippets and how `web_fetch` labels a page as untrusted before the model sees it.
4. Let errors throw. `runTool` catches them and turns them into text the model can act on. Do not catch an error just to hide it.
5. If the tool produces an image or a poll, follow how `generate_image` and `create_poll` return an `attachment` or `poll`. Do not screen it in the tool. `respond()` in `src/respond.ts` screens every attachment before posting, and drops it (with a fixed note) if the screen blocks it or fails. Put what the file was made from in the attachment's `prompt` so the screen has context. An attachment that is not a PNG or JPEG is dropped, so teach `imageDataUrl` in `src/images.ts` about a new type if you add one.
6. Respect the limits. Each tool call counts toward `MAX_TOOL_CALLS`. If the tool has its own per-reply or per-day cap, put it in the reply tally or the shared tool state.
7. If the tool calls an outside service, take `fetch` from the context so tests can fake it. If it sends data to a new place, add it to the network table in `docs/audit.md`.
8. Add tests in `test/tools.test.ts` (or a new file) with `callTool` and `fakeFetch`.
9. Add the tool to the list of what gork can do in the README.

## Add a personality

A personality is one Markdown file in `personas/`. No code change is needed. gork reads the file when it starts. After you edit a persona file, run `npm run up`, which restarts gork when the file changed.

1. Copy `personas/custom.example.md` to `personas/<name>.md`. The name may use letters, numbers, `-` and `_`. Do not use `custom` for a preset. That name is the user's own file, and it is ignored by git.
2. Fill in the front matter. Keys are `name`, `description`, `quirk`, `quirk_rate` and the `reply.*` lines. All are optional. The example file lists every key.
3. Write the body: who the bot is, how it talks and what humor it has. Add three or four short voice examples. Do not repeat the built-in rules about accuracy, tools, mentions, length or safety. gork adds those itself.
4. Keep each reply line on one line. Keep roasts aimed at ideas, not people.
5. Run `npm test`. The tests in `test/persona.test.ts` parse every shipped preset and fail on unknown keys or bad values.
6. Add the new name to the presets table in `docs/personalities.md`. The `PERSONA` help text in `src/config.ts` lists the presets too, so update it and then run `node scripts/env-example.ts`.

Safety replies (self-harm and "safety check is down") are fixed in code. A personality cannot change them, and a pull request should not try.

## Dependencies

Dependabot proposes updates weekly, each only after a cooldown (3 days, 7 for a major version of an npm package). Minor and patch updates of npm packages and GitHub Actions merge themselves once CI and the secret scan pass; major updates, base-image updates and updates whose package changed maintainers need a review. CI installs with `--ignore-scripts` and runs `npm audit signatures`, so a new dependency that needs an install script, or whose signature doesn't check out, fails CI.

Dependabot doesn't see the FFmpeg, OpenSSL, LAME and dav1d `ARG` lines in the `Dockerfile`, so bump those versions and their SHA-256 values by hand.

## Docs

Write plain, short sentences. Say what a thing does, then how to use it. If you change behavior the README describes, change the README in the same pull request.

## Security

Do not report security problems in a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your work is released under the [Zero-Clause BSD license](LICENSE), like the rest of the project.

## AI agents

If you use an AI coding agent, point it at [AGENTS.md](AGENTS.md). It has the same rules as this page in a shorter form.
