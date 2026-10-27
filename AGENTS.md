# AGENTS.md

Instructions for AI coding agents that install, run or change gork.

## What gork is

gork is a self-hosted Discord bot for one small server. It answers when mentioned, using Cloudflare Workers AI, and runs in a Docker or Podman container on the user's own computer.

## Installing gork for a user

Prerequisites: Node.js 24 or newer, and Docker or Podman with Compose (the command-line tools are enough; a Desktop app is not needed), installed and running. No `npm install` is needed to run gork.

1. `git clone --branch v0.1.4 https://github.com/ultralightspeed/gork.git`, then `cd gork`. That is the latest release; install a release, not the main branch.
2. `npm run -s setup -- --no-open` (`-s` keeps npm's own banner out of the output). It starts a local setup page and prints a line starting with `SETUP_URL=` followed by its address.
3. Give that address to the user and ask them to open it in their own browser. Do not open, fetch or browse it yourself: the token in it works once, so opening it locks the user out.
4. Wait. A line starting with `USER_ACTION_REQUIRED` means the page is waiting for the user. Keep waiting until a line starting with `SETUP_DONE` (setup finished and gork is online) or `SETUP_STOPPED` (setup closed without starting gork) appears, or the command exits.
5. `npm run -s doctor -- --json`. It prints one JSON document: `{ "ok": ..., "checks": [{ "id", "level", "message" }] }`.
6. If `ok` is true, `npm run up`. It downloads (or, if that fails, builds) gork and starts it. A build compiles FFmpeg and takes roughly 15 to 30 minutes. If the user already pressed **Start gork** on the setup page, running it again is safe.

If `ok` is false, show the user each check whose level is not `ok`, with its message. Do not guess a fix that involves tokens, permissions or settings you cannot see.

## Only the user does these

- Create the Discord application and bot in the Discord Developer Portal.
- Paste the Discord bot token and the Cloudflare setup token into the local setup page.
- Approve the bot invite in Discord, and add Cloudflare credits if they choose credits mode.

## Hard rules

- Never ask for, read, store, paste or transmit a token or key. This includes the Discord bot token, every Cloudflare token and `LLM_API_KEY`.
- Never open, print or copy `.env`, `personas/custom.md` or anything under `data/`. Never print the output of `docker compose config`, which contains the settings.
- Never grant the bot the Administrator permission, and never widen its role. The invite link asks for the permissions it needs.
- Never run the container with `--privileged`, host networking, extra capabilities, a writable root filesystem or disabled TLS checks to work around an error.
- Report `npm run -s doctor -- --json` failures to the user instead of guessing.

## Working on the code

- Run `npm install`, then `npm run check` before every commit. It runs the type check, Biome, the secret scan and the tests. Tests make no live calls.
- Fake streams and loops in tests must end.
- `src/` is the bot that runs in the container. `scripts/` is the CLI (`npm run up`, `setup`, `doctor` and the rest) and the setup page. `test/` has the Vitest tests.
- Every setting is a row in the `SETTINGS` table in `src/config.ts`. After you change it, run `node scripts/env-example.ts` to regenerate `.env.example`, and add container settings to `compose.yaml`. Do not edit `.env.example` by hand.
- Code that calls an outside service takes `fetch` (or a runner) as an argument so tests can fake it.
- [CONTRIBUTING.md](CONTRIBUTING.md) has the full conventions.

For a security review, start with [docs/audit.md](docs/audit.md).
