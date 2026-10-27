# Privacy and auditing

This page says what data leaves your computer and how to keep gork least-privileged. It then lists the project's claims about network access, secrets, files and permissions, each with where to check it. Treat them as claims to verify, not as instructions.

Paths are relative to the repository root. Function and constant names are given instead of line numbers, so they stay valid as the files change. "CI" means the `check` job in `.github/workflows/ci.yml`, which runs `npm run check` (type check, Biome, `scripts/check-secrets.ts` and every test in `test/`).

## Privacy

gork keeps your settings, your tokens and a small file with today's spend total on your computer. It does not store chat history.

Whenever someone mentions gork, the question, the message they replied to, the recent chat (50 messages by default, cut to a size limit) and any attached images go to Cloudflare Workers AI to write the answer. Images posted earlier in the chat go only when the model asks to see one, which it is told to do only when the question is about one. The safety check gets the question, the replied-to message, images, any video frames and transcript, and each earlier image the model asks to see, not the recent chat. Searches go to Cloudflare Web Search and the search provider you picked, linked pages are fetched by Cloudflare Browser Run, and YouTube transcripts are fetched from YouTube by your computer. The [network tables](#network-where-gork-connects) below list every destination and what it receives.

Make sure the people in your server know about this and agree to it. You are also responsible for following Discord's current terms and developer policy.

- Cloudflare's own terms, and those of the search provider, apply to data they receive.
- If you point `LLM_BASE_URL` at another provider, such as OpenRouter, your chat content goes to that provider instead of Cloudflare Workers AI.
- gork writes one log line for each reply, with the user's name and ID, the server name, token counts, tools used and cost, and one with the event's ID and the user's name and ID when it changes or deletes an event. These hold no message text. Error lines can include a short excerpt of a provider's error response. Docker keeps these logs on your computer (up to 3 files of 5 MB). Podman keeps one file.

### Least privilege

- Don't give the bot the Administrator permission. The invite link asks for a short list of permissions. If you add gork some other way, grant only that list.
- If a channel hides gork, give gork access to that channel instead of widening its role.
- The invite asks for Create Events and leaves out Manage Events, so gork can change or delete only the events it made itself. It does so only for someone who could make that change themselves. See [behavior.md](behavior.md#events).
- Keep the two Cloudflare tokens separate. The admin token stays on your computer and does not enter the container. It can change every AI Gateway in your account, so keep it as private as the runtime token.
- Keep prepaid credits small and auto top-up off.
- Keep `.env` private. Don't share it, commit it, or paste it into a chat or an issue. The same goes for the output of `docker compose config`, which prints your settings.
- If a token leaks, reset or delete it right away in the Discord Developer Portal or the Cloudflare dashboard.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Network: where gork connects

### The bot (inside the container)

| Destination | What it receives | Where to check |
|---|---|---|
| `discord.com` (REST API) and `gateway.discord.gg` (WebSocket gateway; Discord can send another `*.discord.gg` host to resume a session) | The bot token; the replies, polls and events gork posts; and its changes to and deletions of events. gork also reads the server's event list from it. | `src/index.ts` (discord.js `Client`); `src/discord-event.ts` |
| `cdn.discordapp.com`, `media.discordapp.net`, `images-ext-*.discordapp.net` | Downloads of images attached to or previewed in the asked-about messages, and of images earlier in the chat that the model asks to see. No token is sent. | `HOSTS` and `viewableImageUrl` in `src/images.ts` (applied to every message by `toMsg` in `src/message.ts`); `EarlierImages` in `src/earlierimages.ts` |
| `cdn.discordapp.com`, `media.discordapp.net` (by ffmpeg) | Downloads of an attached video, over verified TLS, with no redirects. | `HOSTS` in `src/video.ts`; `guardedInput` in `src/ffmpeg.ts` |
| `api.cloudflare.com` `/accounts/<id>/ai/v1/chat/completions` | The system prompt, the question, the replied-to message, recent channel messages (`CONTEXT_MESSAGES`, 50 by default, cut to a size limit), attached images, images from earlier in the chat that the model asks to see (up to 4 a reply), a video's transcript and frames (up to 8 evenly spaced at first, more when the model asks for a stretch of the clip, up to 60 in all), and tool results. In credits mode the request carries `cf-aig-gateway-id`, so it goes through the user's AI Gateway. In free mode it goes to Workers AI directly. | `chat` in `src/llm.ts`; `loadConfig` in `src/config.ts` |
| `api.cloudflare.com` `/ai/run/@cf/cloudflare/clef-flash` | The text and images being screened: the request, the replied-to message, a video's frames (one per second, up to 60) and transcript, the draft reply, poll text, the text of an event gork creates or changes and the note about one it deletes, each generated image, and each image from earlier in the chat that the model asks to see (on its own, before the model gets it). Called directly, not through the gateway. | `checkOnce` in `src/guard.ts` |
| `api.cloudflare.com` `/ai/run/@cf/black-forest-labs/flux-1-schnell` | The image prompt. Called directly. | `generateImage` in `src/imagegen.ts` |
| `api.cloudflare.com` `/ai/run/@cf/openai/whisper-large-v3-turbo` | A video's soundtrack, as mono MP3. Called directly. | `WHISPER_MODEL` in `src/video.ts` |
| `api.cloudflare.com` `/ai/websearch` (credits mode only) | The search query (at most 300 characters). Cloudflare passes it to the search provider in `SEARCH_PROVIDER` (ceramic by default) for a reply's first search, and to the one in `SEARCH_FALLBACK` (linkup by default) for a reply's further searches and for a first search that fails or finds nothing; gork does not contact a provider itself. Ceramic and Linkup keep no copy of the query (zero data retention); Exa, which can only be `SEARCH_PROVIDER`, does, and `npm run doctor` warns when it is set. Cloudflare's provider table says so; its October 2026 launch note says all three keep none. | `webSearch` and `searchWithFallback` in `src/search.ts`; `SEARCH_PROVIDERS` in `src/search-providers.ts`; `toolsFor` in `src/tools.ts` drops the tool in free mode |
| `api.cloudflare.com` `/browser-rendering/markdown` | The URL of a page to read. Cloudflare fetches the page; gork does not contact the page's host. Only public http(s) host names are accepted, and only links from the question, the replied-to message, any site the personality names (it is the operator's own instructions), this reply's search results, or links printed on a page it already read that stay on that page's site (a page is written before the chat, so its links can't carry chat text). | `readableUrl` and `fetchPage` in `src/webfetch.ts` |
| `www.youtube.com` (`/youtubei/v1/player` and `/api/timedtext`) | A YouTube video ID. No token is sent. | `PLAYER_URL` and `load` in `src/youtube.ts` |
| `LLM_BASE_URL`, only if the user sets it | Everything listed for chat completions above, and `LLM_API_KEY`. The Cloudflare runtime token is sent only to `api.cloudflare.com` or `gateway.ai.cloudflare.com`; any other host needs its own key. | `llmKey` and `CLOUDFLARE_HOSTS` in `src/config.ts` |

`gateway.ai.cloudflare.com` is contacted only if the user sets `LLM_BASE_URL` to it. Every Cloudflare call from the bot uses `CF_RUN_TOKEN` (`cfFetch` in `src/cf.ts`), except the chat call, which uses `LLM_API_KEY` when it is set (`chat` in `src/llm.ts`).

`test/egress.test.ts` checks the network destinations in the source against an allowed list.

### The CLI (on the user's computer)

| Destination | What it receives | Where to check |
|---|---|---|
| `discord.com/api/v10` | The bot token pasted into the setup page, or `DISCORD_TOKEN` for `npm run doctor`. Used to read the application, turn on the Message Content intent and list the bot's servers. | `API` and `call` in `scripts/lib/discord-setup.ts` |
| `api.cloudflare.com/client/v4` | The setup token (to find the account, create the two runtime tokens and delete itself), `CF_ADMIN_TOKEN` (to create or update the AI Gateway), and `CF_RUN_TOKEN` (for the checks in `npm run doctor` and `npm run probe`). | `raw` in `scripts/lib/cloudflare-setup.ts`; `cloudflareApi` in `scripts/lib/gateway.ts`; `scripts/probe.ts` |
| `www.youtube.com` | A fixed video ID, from `npm run probe` only. | `scripts/probe.ts` |
| `ghcr.io` (by Docker or Podman) | An image pull for `ghcr.io/ultralightspeed/gork:<package.json version>`. No token is passed. | `chooseImage` and `IMAGE_REPO` in `scripts/lib/image.ts` |
| Docker Hub, the Alpine package mirror, the npm registry, and the source archive hosts in `Dockerfile` | Only for a local build: the base image (pinned by digest), Alpine build packages from `apk add` (not pinned by version or hash), `discord.js` and its dependencies from `npm ci` (pinned by the lockfile's integrity hashes), and the OpenSSL, LAME, dav1d and FFmpeg source archives (each checked against a recorded SHA-256). | `Dockerfile`; `package-lock.json`; `test/dockerfile.test.ts` |

The setup page listens on `127.0.0.1` on a random port (`server.listen` in `scripts/lib/setup-server.ts`). Its address carries a random token that works once. The first browser to open it gets a cookie scoped to a secret path chosen for that run, so other ports on `127.0.0.1` never receive the cookie, and the address stops working. The page refuses requests whose origin is another website. It loads nothing from other hosts: its outside addresses are links the user clicks (Discord, Cloudflare, Docker and Podman pages).

There is no telemetry, analytics or update check. Apart from the destinations a local build needs, the tables above list every destination.

## Secrets

| Claim | Where to check |
|---|---|
| Settings and tokens are kept in `.env`. Setup writes it once, refuses to overwrite an existing one, and makes it readable only by the user (mode 0600, or `icacls` on Windows). | `writeEnvFile` in `scripts/lib/env-file.ts`; `test/env-file.test.ts` |
| The container receives only the settings the bot reads. `CF_ADMIN_TOKEN` is host-only and does not enter the container. | `environment:` in `compose.yaml`; `scope: "host"` rows in `SETTINGS` in `src/config.ts`; `test/env-sync.test.ts` |
| The runtime token (`gork-run`) has only AI Gateway Read and Run, Workers AI Read, Websearch Run and Browser Run Write (free mode: Workers AI Read and Browser Run Write). The admin token has only AI Gateway Read and Write, which covers every AI Gateway in the account, so it can change or delete any of them. | `runNeeds` and `ADMIN_NEEDS` in `scripts/lib/cloudflare-setup.ts`; `test/cloudflare-setup.test.ts` |
| The setup token is deleted at the end of setup, and setup checks that it has stopped working. Stopping or failing setup deletes what it created. | `scripts/lib/setup-session.ts`; `scripts/lib/setup-cleanup.ts`; `test/setup-session.test.ts`, `test/setup-cleanup.test.ts` |
| Tokens pasted into the setup page stay in memory, are not sent back to the page, and are replaced with `[hidden]` in any output or error the page shows. | `redact` in `scripts/lib/setup-session.ts`; `test/setup-session.test.ts` |
| Error messages about settings give the setting's name, not its value. | `SettingsError` in `src/config.ts`; `test/config.test.ts` |
| ffmpeg is started with only `PATH` in its environment, so the bot's tokens don't reach it. It still runs as the same user as the bot (see [Limits](#limits)). | `bareEnv` in `src/ffmpeg.ts`; `test/ffmpeg.test.ts` |
| No token-shaped string and no `.env` file is committed. | `scripts/check-secrets.ts` (in `npm run check`); `.github/workflows/secret-scan.yml` runs gitleaks over the full history on every push |
| A planted fake credential does not leak into requests to other hosts, log lines or error messages. | `test/canary.test.ts` |
| Tokens only travel over TLS that refuses the roots above the eMudhra intermediates whose private keys were compromised in October 2026 (<https://emudhra.we-have-a-problem.com/>), even where Node or the system still trusts them. The bot and every host script remove them from the trust store before connecting, and the image's CA bundle (ffmpeg's) is built without them. | `DISTRUSTED_ROOTS` in `src/distrust.ts`; `Dockerfile`; `test/distrust.test.ts` |

## Subprocesses

| Who | What runs | Where to check |
|---|---|---|
| The bot | `ffmpeg`, the only subprocess, with `-protocol_whitelist https,tls,tcp`, `-format_whitelist` limited to MP4, MOV, Matroska and WebM demuxers, `-max_redirects 0`, `-max_alloc` 16 MiB, `-tls_verify 1` with a CA file, one thread, stdin closed, and a duration cap. It is killed at a time limit or when its output passes a size limit, and only one runs at a time. Arguments are passed as an array, with no shell. | `guardedInput`, `runFfmpeg` and `bareEnv` in `src/ffmpeg.ts`; limits in `src/video.ts`; `test/ffmpeg.test.ts` |
| The CLI | `docker` or `podman` (and `docker-compose` or `podman-compose`), with argument arrays, no shell. | `scripts/lib/engine.ts`; `scripts/lib/compose.ts`; `test/engine.test.ts`, `test/compose.test.ts` |
| The CLI | `icacls` on Windows, to make `.env` private. | `realHost` in `scripts/lib/env-file.ts` |
| The CLI | `cmd /c start`, `open` or `xdg-open`, to open the setup page. The address is checked against a strict pattern (local address, hex token) first. | `openBrowser` and `SETUP_URL` in `scripts/lib/open-browser.ts`; `test/open-browser.test.ts` |
| Development only | `git ls-files`, for the secret scan. | `scripts/check-secrets.ts` |

## Files

| Claim | Where to check |
|---|---|
| The container's root filesystem is read-only. It can write only to `/data` (a named volume holding `ledger.json`, today's spend) and a `/tmp` tmpfs (the heartbeat file). Personas are mounted read-only. | `read_only`, `tmpfs` and `volumes` in `compose.yaml`; `src/budget.ts`; `HEARTBEAT_FILE` in `src/heartbeat.ts`; `test/dockerfile.test.ts` |
| The container runs as user 1000, with all capabilities dropped, `no-new-privileges`, 384 MB of memory, one CPU and at most 128 processes, on the default bridge network. | `Dockerfile` (`USER 1000:1000`); `compose.yaml`; `test/dockerfile.test.ts` |
| The CLI writes `.env`, a temporary `.env.setup-lock` while setup runs, and `personas/custom.md` when the user saves a custom personality. | `scripts/lib/env-file.ts`; `acquireSetupLock` in `scripts/lib/setup-lock.ts`; `scripts/lib/custom-persona.ts` |

## Discord permissions

| Claim | Where to check |
|---|---|
| The invite asks for permissions integer `580817017490432`: View Channels, Send Messages, Send Messages in Threads, Read Message History, Embed Links, Attach Files, Create Events and Send Polls. | `INVITE_PERMISSIONS` in `scripts/lib/discord-setup.ts`; `test/discord-setup.test.ts` |
| Mention Everyone is added (`580817017621504`) only when `MENTIONS` includes `everyone`. | `inviteUrl` in `scripts/lib/discord-setup.ts`; `test/discord-setup.test.ts` |
| Administrator is not requested, with or without Mention Everyone. | `test/discord-setup.test.ts` |
| The bot uses three gateway intents: Guilds, Guild Messages and Message Content. | `intents` in `src/index.ts` |
| Replies ping nobody by default. Pings follow the `MENTIONS` setting and the asker's own permissions. `@everyone` also needs `MENTIONS` to include it, the asker's Mention Everyone permission, and the asker's own message to say everyone (or `@here`, or announce). A page could only add a ping to a reply where someone with that permission already said everyone; this is accepted. | `allowedMentions` in `src/discord-reply.ts`; `src/mentions.ts`, `src/intent.ts`; `ping_everyone` in `src/tools.ts`; `test/tools.test.ts`, `test/mentions.test.ts`, `test/intent.test.ts`, `test/discord-reply.test.ts`; [behavior.md](behavior.md#pings) |
| An event is created only when both the asker and the bot have Create Events. There is no wording check: an event is one per reply, screened, visible and deletable, and the asker could make it themselves, so a page talking gork into one is an accepted low risk. | `eventRefusal` in `src/discord-access.ts`; `create_event` in `src/tools.ts`; `test/discord-access.test.ts`, `test/permissions.test.ts`; [behavior.md](behavior.md#events) |
| `list_events` lists only events every member can see: those at a location, and those in voice or Stage channels the @everyone role can view (that the asker and the bot can see too). The list reads the same whether or not other events exist, so a reply, which everyone in the channel can read, reveals nothing about events in private channels, even when untrusted text steers the model to list events. Names and descriptions reach the model as untrusted text, on one line each. `web_fetch` doesn't open Discord event links (Discord answers with a login page). | `readEvent` and `serverEvents` in `src/discord-event.ts`; `formatEventList` in `src/event.ts`; `list_events` and `web_fetch` in `src/tools.ts`; `test/event.test.ts`, `test/discord-event.test.ts`, `test/tools.test.ts` |
| An event is changed or deleted only when both the asker and the bot may do that themselves, by Discord's rule: Manage Events, or Create Events for an event of their own, plus View Channel and Connect (or the Stage permissions) in its channel. Discord counts an event the bot made as the bot's. | `eventChangeBlock` in `src/permissions.ts`; `eventChangeWhyNot` and `eventAccess` in `src/discord-access.ts`; `readEvent` in `src/discord-event.ts`; `test/permissions.test.ts`, `test/discord-access.test.ts`, `test/discord-event.test.ts` |
| A move needs both the asker and the bot to be allowed to change the event in the destination channel as well (each channel's overrides count). A channel name that isn't one of those is refused, with the same words whether the channel exists or not, and never becomes a location. An event in a channel not every member can see is never moved, so a change never shows an event to more members. A repeating event only gets a new name or description, and isn't deleted; a link to one time of a repeating event is refused. | `moveTargets`, `editOptions` and `changeGuildEvent` in `src/discord-event.ts`; `placeEdit` in `src/tools.ts`; `parseEventEdit` and `eventIdFrom` in `src/event.ts`; `test/discord-event.test.ts`, `test/tools.test.ts`, `test/event.test.ts` |
| Deleting also needs the asker's own words (`message.content`, which holds no forwarded text) to say delete, cancel or remove, and the event to be named there or in the replied-to message: by its link or ID, or by a word of its name that no other event's name has. This is a word match, not proof of intent. Changing has no wording check, for the same reason as creating: one per reply, screened, named in the reply, and the asker could make it themselves. A reply creates, changes or deletes one event at most. | `asksToDelete` and `namesEvent` in `src/event.ts`; `askerText` in `src/index.ts`; `edit_event` and `delete_event` in `src/tools.ts`; `answer` in `src/llm.ts`; `test/event.test.ts`, `test/tools.test.ts`, `test/llm.test.ts` |
| A change is made only after the reply passes the screen and is posted, and only after the event is read from Discord again and every check passes again, with the permissions Discord last sent. An edit carries an audit-log reason naming the asker. Discord takes no reason with a deletion, so gork logs the deleted event's ID with the asker, and posts a screened note naming the event. | `changeGuildEvent` in `src/discord-event.ts`; `postEventChange` and `sendReply` in `src/discord-reply.ts`; `handle` in `src/index.ts`; `respond` in `src/respond.ts`; `test/discord-event.test.ts`, `test/discord-reply.test.ts`, `test/respond.test.ts` |
| A poll is posted only when both the asker and the bot have Send Polls in that channel (no wording check, for the same reason as events). | `pollRefusal` in `src/discord-access.ts`; `create_poll` in `src/tools.ts`; `channelAbilities` in `src/permissions.ts`; `test/discord-access.test.ts`, `test/permissions.test.ts`, `test/tools.test.ts`, `test/respond.test.ts`; [behavior.md](behavior.md#polls) |
| A generated image is posted only when both the asker and the bot have Attach Files in that channel. | `channelAbilities` in `src/permissions.ts`; `src/respond.ts`; `test/permissions.test.ts`, `test/respond.test.ts`; [behavior.md](behavior.md#images) |
| A reply keeps link previews only when the asker has Embed Links in that channel and every link in it came from the question or the replied-to message. | `hidesPreviews` and `givenLinks` in `src/links.ts`; `sendReply` in `src/discord-reply.ts`; `test/links.test.ts`, `test/discord-reply.test.ts`; [behavior.md](behavior.md#link-previews) |

## What Cloudflare receives, and logging

- The content listed in the network table above goes to Cloudflare, which processes it under its own terms.
- Every web search is held in the daily budget at its own provider's price (`SEARCH_PROVIDERS` in `src/search-providers.ts`) just before it is sent, and only searches that answered are charged. The fallback provider is used at most 2 times a reply and `SEARCH_FALLBACK_PER_DAY` times a day (20 by default, about $0.10 with Linkup; the count is kept in memory and restarts with gork, and `DAILY_BUDGET_USD` caps all spending). Search log lines name providers and HTTP statuses, never the query or a provider's error text. Check `searchWithFallback` in `src/search.ts` and `test/search-fallback.test.ts`.
- In credits mode, chat and web search requests carry `cf-aig-collect-log-payload: false`, so the AI Gateway does not log prompts or responses. The gateway still logs request metadata (`collect_logs: true`), such as the model, token counts and cost. Check `chat` in `src/llm.ts`, `webSearch` in `src/search.ts` and `scripts/lib/gateway.ts`.
- The gateway that `npm run up` creates has zero data retention (`zdr: true`), authentication on, and a daily spend limit of about 1.2 times `DAILY_BUDGET_USD`. Check `scripts/lib/gateway.ts` and `test/gateway.test.ts`.
- These gateway settings cover only calls that go through the gateway. The network table shows which calls go to Workers AI directly, and the [README](../README.md#what-it-costs) explains what that means for billing.
- The bot's per-reply log line holds names, IDs, token counts, tools used and cost, not message text. Error lines can include a short excerpt of a provider's error response (`CfError` in `src/cf.ts` keeps 200 characters of it, and `describeError` in `src/errors.ts` cuts each error line to 220).

## The safety screen

- Every request (with the replied-to message, images, video frames and transcript) and every reply (with poll text, the text of an event it creates or changes, and each generated image) is screened by Cloudflare's Clef-Flash model before anything is posted. An image from earlier in the chat is screened before the model is shown it, and isn't shown unless it passes. Check `screenRequest`, `screenEarlierImages` and `screenReply` in `src/guard.ts`, `EarlierImages` in `src/earlierimages.ts`, and `respond` in `src/respond.ts`.
- Invisible characters (zero-width and other Unicode format characters) are stripped from the text gork receives and posts before the safety screen and the model see it. Check `stripInvisible` in `src/context.ts`.
- It fails closed: if the screen errors or answers in an unexpected shape, gork posts nothing it wrote. For an image from earlier in the chat, failing closed means the model isn't shown that image; the reply still goes through the reply screen as usual. Check `yesProbability` in `src/guard.ts` and `test/guard.test.ts`, `test/respond.test.ts`, `test/earlierimages.test.ts`.
- Self-harm, "safety check is down" and "free allowance used up" replies are fixed in code, not in personas. Check `SAFETY_REPLIES` in `src/persona.ts`.
- `npm run calibrate` runs a fixed set of requests through the live screen and prints each verdict.

## Supply chain

| Claim | Where to check |
|---|---|
| One runtime dependency: `discord.js`. | `dependencies` in `package.json` |
| No install scripts run. The only package in the lockfile with an install script is `fsevents`, an optional macOS-only development dependency, and CI and the image install with `npm ci --ignore-scripts`. | `hasInstallScript` in `package-lock.json`; `test/lockfile.test.ts`; `.github/workflows/ci.yml`, `image.yml`, `Dockerfile` |
| CI checks every installed package's npm registry signature (`npm audit signatures`) before it runs any of the code. | `.github/workflows/ci.yml`, `image.yml`; `test/workflows.test.ts` |
| Dependabot proposes an update only after a cooldown: 3 days after its release, 7 for a major version of an npm package (security updates don't wait). Minor and patch updates of npm packages and GitHub Actions, and patch updates of the base image, merge themselves, and only after the checks the `main` ruleset requires (CI, the secret scan and the image check, which builds and checks the image whenever something that goes into it changes) pass. Major updates, base-image minor updates and any update whose package changed maintainers wait for a person. Dependabot malware alerts are on, so a dependency matching a known malicious package raises an alert. | `.github/dependabot.yml`; `.github/workflows/dependabot-auto-merge.yml`; `test/workflows.test.ts` |
| No build step and no minified code. Node runs the TypeScript in `src/` and `scripts/` directly, with type stripping. | `package.json` scripts; `tsconfig.json` (`erasableSyntaxOnly`) |
| The CLI needs no `npm install`; it uses only Node's built-in modules. | CI job `cli-without-install` in `.github/workflows/ci.yml` |
| Base images are pinned by digest, and source archives by SHA-256. The `Dockerfile` has no `# syntax=` line, so a build doesn't download a Dockerfile frontend image. | `Dockerfile`; `test/dockerfile.test.ts` |
| Every GitHub Action is pinned to a full commit SHA, runners are pinned, and workflows default to read-only permissions. | `.github/workflows/*.yml`; `test/workflows.test.ts` |
| Release builds use a pinned BuildKit image, take no build cache from other jobs, upload no build record, and embed no BuildKit provenance (which would carry the pusher's details). | `.github/workflows/image.yml`; `test/workflows.test.ts` |

### Verifying a release image

Release images are built by `.github/workflows/image.yml` from a `v*` tag, on GitHub's own runners, with a GitHub artifact attestation. Each release's notes list the image's digest (the `index` line). To check that the image with that digest was built by that workflow from that tag, with the [GitHub CLI](https://cli.github.com/) signed in to any account:

```sh
gh attestation verify oci://ghcr.io/ultralightspeed/gork@sha256:<index digest> --repo ultralightspeed/gork --signer-workflow ultralightspeed/gork/.github/workflows/image.yml --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

A tag can be moved and a digest can't, so check by digest, and run that digest by pinning it in `GORK_IMAGE` ([setup.md](setup.md#checking-the-image)). To compare an image with the source, build it yourself with `npm run up -- --build` and read the `Dockerfile`.

## Limits

- gork has a single maintainer and has had no independent security audit.
- The safety screen is a classifier. It reduces harmful output; it is not access control, and it covers only five categories (see [behavior.md](behavior.md#safety)).
- A strike counts only what the asker puts in their own message. An image they replied to, or posted earlier and then asked about, earns none, so someone can keep trying the image screen without being muted. Each blocked image is still refused and logged.
- Cloudflare processes all content it receives: prompts, recent channel messages, images, video frames and transcripts.
- ffmpeg runs in the same container as the bot, as the same user. A code-execution bug in ffmpeg, triggered by a crafted video, could read the bot's tokens. [SECURITY.md](../SECURITY.md) lists the limits gork puts on it, and `VIDEOS_PER_DAY=0` turns video off.
- No defense against prompt injection is complete. gork labels chat text and web pages as untrusted, but a model can still be misled.
