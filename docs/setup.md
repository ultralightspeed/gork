# Setup in detail

The [README](../README.md#quickstart) has the short version: run `npm run setup` and follow the page. This page explains what the setup page does, how to set gork up by hand, which container engine and image it uses, free mode, and the commands you use after setup.

## What the setup page does

`npm run setup` starts a small web page on your own computer and opens it in your browser. It does the typing and checking for you, and asks you to do only what a person has to do: create a Discord bot and copy its token, click Authorize on the invite, create a Cloudflare setup token and copy it, and (in credits mode) add credits. The page has four steps that unlock one after another and tick themselves off.

1. Step 1 asks how gork pays for the AI model (free mode or credits mode, see [below](#free-mode-in-detail)) and which personality it has. Choose custom to open an editor and write your own, which the page saves as `personas/custom.md` (see [personalities.md](personalities.md)). Then pick who it may mention (the `MENTIONS` setting, see [behavior.md](behavior.md#pings)), your time zone (the page fills in your browser's), and in credits mode a daily budget (50 cents by default).
2. In the Discord step, a button opens the Discord Developer Portal and the page tells you where to click. You paste the bot token into a box, which has Show and Paste buttons and tells you at once if the token has the wrong shape. The page checks the token and turns on the Message Content setting gork needs to read messages; if Discord refuses, it tells you where to click. If the bot is Public, the page shows the clicks to turn that off (first Installation, Install Link, None; then Bot, Public Bot off) and ticks them off when Discord confirms. You can also leave it on. Then a button opens the invite link (it asks for Mention Everyone only if your mention choice includes `everyone`). The page waits for gork to join and shows you the server by name to confirm. If Discord won't list servers, you can paste a server ID instead.
3. In the Cloudflare step, a button opens a Cloudflare form that is already filled in. Pick your account, set the token's expiry to one hour so it expires by itself if anything goes wrong, create it and paste the secret. The page then finds your account, creates two tokens limited to what gork needs, creates or updates the AI Gateway, and tests the runtime token. In credits mode, if there are no credits yet, it shows the link and checks every few seconds until they appear (or you can carry on without).
4. The last step saves your settings and starts gork. If the page finds old `gork-run` or `gork-admin` tokens from an earlier setup, it lists them with a tick box to revoke them. The box is ticked by default; a gork you already run that still uses them will stop working. **Save the settings** writes your `.env` settings file, all at once, and locks it to your user (with `icacls` on Windows). Only then does it delete the setup token and check that it has stopped working, so that is the last thing it does. **Start gork** then does the same as `npm run up` and shows its progress. If neither Docker nor Podman is installed and running, the page says what to start, with links to Docker Desktop and Podman Desktop and a Retry button. When gork is online, the page says so and which server to say hi in.

If an AI Gateway with the chosen id already exists, the page shows its settings and asks what to do: use it and change its settings, use a different id (the page writes it to `AI_GATEWAY_ID`), or cancel. Nothing is changed unless you choose. `npm run up` says whether it created the gateway, updated it, or found it already up to date.

The admin token lets `npm run up`, `npm run gateway` and `npm run destroy` change the AI Gateway. It has only AI Gateway Read and Write, and it stays on your computer. That permission covers every AI Gateway in your Cloudflare account, so the token could change or delete any of them; keep it as private as the runtime token. By default it is a standing token, and the page writes it to `.env`. If you untick "Keep an admin key on this computer", you get a token that expires after one hour instead. After that, those three commands stop working until you put a new `CF_ADMIN_TOKEN` in `.env`.

Good to know:

- The page needs no terminal input, so it works the same in PowerShell, Windows Terminal and Git Bash. Leave the terminal window open until the page says gork is online.
- Only this computer can reach the page. It listens on `127.0.0.1` on a random port, the address has a long random token in it, and it refuses requests that come from other websites. The address works once: the browser that opens it first gets a cookie, and the address stops working after that. The cookie is tied to a secret path chosen for this run, so other programs listening on `127.0.0.1` never receive it.
- Tokens you paste are kept in memory, sent only to Discord or Cloudflare, written only to `.env`, and not shown back on the page.
- `npm run -s setup -- --no-open` does not open a browser. It prints the address, and lines that start with `SETUP_URL=`, `USER_ACTION_REQUIRED` and then `SETUP_DONE` (gork is online) or `SETUP_STOPPED` (setup closed from the page without starting gork; Ctrl-C prints neither and exits with code 130), so a script or tool that runs setup can show you the address and tell when setup is done.
- Setup stops if `.env` already exists, so it can't overwrite it. Rename the old file (for example to `.env.old`) and run setup again.
- Click **Stop setup** on the page, or press Ctrl+C in the terminal, and setup deletes the tokens and gateway it created, and the setup token too. If it fails partway, or the page sits unused for 30 minutes, it does the same. It then tells you what, if anything, is still active in your Cloudflare account, with a link to the dashboard so you can check.
- Stopping setup does not remove `personas/custom.md`. That is your own writing, saved when you pressed **Continue** in step 1.
- If a Cloudflare step fails after the setup token was used, the token is taken back, so the page asks you to create a new one.
- In credits mode, the page cannot add credits for you. It shows the link and waits. Until you add credits, its tests of the runtime token show a problem about credits. That is expected. Add credit (the minimum top-up is $10, which lasts a long time at gork's usage), then run `npm run doctor`.

## Setting up by hand

You can skip the setup page. These steps work with the code in this repository.

1. In the Discord [Developer Portal](https://discord.com/developers/applications), create an application.
   - Installation: turn User Install off and Guild Install on. Set Install Link to None.
   - Bot: turn Public Bot off. Turn Message Content Intent on. Leave Presence and Server Members off.
   - Bot: click Reset Token and copy the token. It is shown once.
2. Invite the bot by opening this link after replacing `YOUR_APPLICATION_ID` with the Application ID from the General Information page. It asks for the permissions gork uses: View Channels, Send Messages, Send Messages in Threads, Read Message History, Embed Links, Attach Files, Create Events and Send Polls.

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=580817017490432
   ```

   This link does not ask for Mention Everyone. If you plan to set `MENTIONS=everyone` (see [behavior.md](behavior.md#pings)), use `permissions=580817017621504` instead. It adds that one permission.

3. To get the server ID, turn on Developer Mode in Discord (User Settings, Advanced). Right-click your server and choose Copy Server ID.
4. In Cloudflare, find your Account ID in the dashboard. In credits mode, add prepaid credits under AI, AI Gateway, Credits, and keep auto top-up off. Then create two API tokens (My Profile, API Tokens, Create Custom Token):
   - `gork-run`: AI Gateway Read and Run, Workers AI Read, Websearch Run, Browser Run Write. This one goes into the container. In free mode it needs only Workers AI Read and Browser Run Write.
   - `gork-admin`: AI Gateway Read and Write. This one stays on your computer and is not given to the container. It can change every AI Gateway in the account.

   Cloudflare renames things now and then. If a permission has a different name in the dashboard, pick the closest match.
5. Copy `.env.example` to `.env`. Fill in `DISCORD_TOKEN`, `GUILD_IDS`, `CF_ACCOUNT_ID`, `CF_RUN_TOKEN` and `CF_ADMIN_TOKEN`. For free mode, also set `BILLING_MODE=free`. If you already have an AI Gateway named `gork`, set `AI_GATEWAY_ID` to a different name. Put comments on their own lines and do not put quotes around values. A bad value stops `npm run up`, and the message gives the setting's name, not its value: `CF_ACCOUNT_ID` must be 32 hex characters, `AI_GATEWAY_ID` a simple name, and `LLM_BASE_URL` empty or an https address. On Mac or Linux, run `chmod 600 .env` so only you can read it; the setup page does this for you.
6. Start Docker or Podman, then run `npm run up`.

## Docker or Podman, and the image

gork runs in a container. It works with either Docker or Podman, and only needs their command-line tools with Compose; the Desktop apps are just the easy way to get those on Windows and Mac. Anything that provides a working `docker compose` (OrbStack, Colima, Rancher Desktop and so on) works too. `npm run up`, `down`, `logs`, `status`, `destroy`, `doctor` and the setup page's **Start gork** all use the same one.

gork uses Docker if it is running, and Podman otherwise. To force one, put `CONTAINER_ENGINE=docker` or `CONTAINER_ENGINE=podman` in `.env`. `npm run doctor` says which one it found and how it runs Compose. If neither works, the message says which to start: Docker Desktop, or `podman machine start`.

Docker runs Compose as `docker compose`. For Podman, gork runs `podman compose` (Podman 4.7 or newer), which runs docker-compose if it is installed, or podman-compose. If `podman compose` finds neither, gork tries a standalone `podman-compose`. With docker-compose on Linux, Podman needs its API socket: `systemctl --user enable --now podman.socket`.

By default `npm run up` downloads the ready-made image `ghcr.io/ultralightspeed/gork:<version>`, where the version is the one in `package.json`, and starts it. GitHub builds and publishes it for every release (as `1.2.3`, `1.2` and `latest`, for Intel and ARM). The download takes a few minutes. It is pinned to your version, not `latest`, so the image matches the settings and `compose.yaml` next to it.

- If the download fails (you are offline, or that version is not published yet), `npm run up` says so in one line and builds the image on your computer instead. The build compiles FFmpeg and takes 15 to 30 minutes, longer on a Raspberry Pi. If you downloaded the image earlier, it runs that copy.
- `npm run up -- --build`, or `GORK_IMAGE=build` in `.env`, always builds from this folder. Use it after you change the code: the released image holds the release, not your edits.
- `GORK_IMAGE=ghcr.io/you/gork:1.2` runs another image. Write the full name, because Podman has no default registry. If it cannot be downloaded or found, `npm run up` stops rather than build something else.
- `npm run destroy` removes the downloaded image too, but not an image you set in `GORK_IMAGE`.

### Checking the image

`npm run up` downloads the image by its version tag, and doesn't check what it gets. To run exactly the image a release published, pin it by its digest: each release's notes list it, as the `index` line under **Image**. Put it in `.env`:

```
GORK_IMAGE=ghcr.io/ultralightspeed/gork@sha256:<index digest>
```

`npm run up` then runs that image, or stops if it can't get it; it never builds something else instead. When you update gork, change the digest to the new release's, or remove the line, or gork keeps running the old image.

To check that the image was built by this repository's release workflow from that release's tag, use the [GitHub CLI](https://cli.github.com/), signed in to any GitHub account (`gh auth login`):

```sh
gh attestation verify oci://ghcr.io/ultralightspeed/gork@sha256:<index digest> --repo ultralightspeed/gork --signer-workflow ultralightspeed/gork/.github/workflows/image.yml --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

This proves where the image came from, not that its code is safe: for that, read the code of the same release, or build the image yourself with `npm run up -- --build`.

Podman needs a few extra things on some systems. They are in [troubleshooting.md](troubleshooting.md#docker-or-podman-problems).

## Free mode in detail

Free mode uses only Cloudflare's free daily Workers AI allowance.

- It is free only on the Workers Free plan. On Workers Paid, usage beyond the free allowance is billed by Cloudflare.
- Expect about 25 to 100 replies a day. This is an estimate, not a promise. Long chats and tool use make a reply cost more of the allowance.
- Web search is off. It needs credits.
- When the day's allowance is used up, gork answers nothing until 00:00 UTC. The safety check runs on the same allowance, and gork will not answer when it cannot run the check. Either way it says the free allowance is used up and when it resets.
- It uses a smaller model, `@cf/zai-org/glm-4.7-flash`. Do not put a GLM 5.x model in `LLM_MODEL`. Those need the paid plan or credits, and `npm run doctor` warns about them.
- That model can't see images. gork doesn't send it attached images or video frames, and tells it they were there; a video still gets its transcript.
- Model calls go to Workers AI directly, not through the AI Gateway, so they can't use your credits. `LLM_BASE_URL` must stay empty or point at `api.cloudflare.com` (Workers AI direct). Anything else stops `npm run up` with a message.
- `npm run up` still creates or updates the AI Gateway, and sets it to standard billing. It skips the credit balance check. In free mode, `npm run doctor` only warns if the gateway is missing.

You can switch modes later by changing `BILLING_MODE` in `.env` and running `npm run up`. If you switch from free to credits, the runtime token needs more permissions, and `npm run doctor` tells you which are missing.

## Everyday commands

Every setting is in `.env`, and [`.env.example`](../.env.example) lists all of them, grouped, each with a default and a one-line explanation. After you change `.env`, run `npm run up` again. A bad value stops it before anything changes, and the message gives the setting's name, not its value.

Run every command from the folder you set gork up in. Docker and Podman name gork's container and its data after that folder, so a copy in another folder starts a second bot on the same token, with empty data.

| Command | What it does |
|---|---|
| `npm run up` | Checks your settings, creates or updates the AI Gateway, downloads (or builds) gork and starts it. It says whether the gateway was created, updated or already up to date. Safe to re-run, and it is how you apply changes to `.env` or a persona file. |
| `npm run down` | Stops gork. Keeps its data and the gateway. |
| `npm run logs` | Follows the logs. Press Ctrl+C to stop following. |
| `npm run status` | Shows whether gork is running and today's spend. |
| `npm run gateway` | Creates or updates only the AI Gateway. |
| `npm run destroy` | Asks you to type `gork`, then removes the container, its data and image, and the AI Gateway. Your Discord app and Cloudflare tokens stay. |
| `npm run doctor` | Checks your settings, personality, Discord and Cloudflare, and says what to fix. |
| `npm run probe` | A live check of the chat model (including a tool call with an image after it, as video frames use), the safety screen, web search, page reads and YouTube, with your runtime token. |

`npm run up`, `npm run gateway` and `npm run destroy` need the admin token (`CF_ADMIN_TOKEN`). `npm run destroy` deletes the AI Gateway set in `AI_GATEWAY_ID`, and `npm run up` overwrites it with gork's settings, so use a name nothing else uses.

## Updating gork

gork doesn't update itself. Each release has a version number, and `npm run up` runs the image for the version of your copy of gork, so you update by getting the new copy and running `npm run up`. Security fixes come out as new releases, so update when one appears. To hear about them, click **Watch** at the top of the GitHub page, then **Custom**, tick **Releases** and click **Apply**.

1. Get the new release into the same folder. Keep the folder and its name, even if it is `gork-main` from an older download: gork's container and data are named after it.
   - If you used `git clone`: in a terminal in the gork folder, run `git fetch --tags`, then `git checkout v<new version>` with the release's name, such as `git checkout v1.2.3`.
   - If you downloaded a ZIP: on the [latest release](https://github.com/ultralightspeed/gork/releases/latest), click **Source code (zip)** under **Assets**, open it, and copy everything inside its folder over your gork folder, replacing the files when asked. Your `.env`, your `personas/custom.md` and gork's data are not in the ZIP, so they stay as they are.
2. Run `npm run up`. It downloads the new version's image and restarts gork with your settings. If you pinned the image in `GORK_IMAGE` (see [Checking the image](#checking-the-image)), change it to the new release's digest first.

The [releases page](https://github.com/ultralightspeed/gork/releases) says what changed in each version.

## Checking things

- `npm run doctor` prints `ok`, `warn` or `FAIL` for each check. A `warn` is advice. A `FAIL` means something must be fixed. By default it runs only free checks; in credits mode that includes a one-token chat call, which is almost free. `npm run doctor -- --live` also runs a paid web search on each search provider to test the runtime token, which costs about $0.00525 with the defaults (Ceramic and Linkup). In credits mode it also says which providers web search uses and the most the fallback can cost a day. It also says which container engine it found and which image `npm run up` will start.
- `npm run -s doctor -- --json` prints the same checks as one JSON document, `{ "ok": true, "checks": [{ "id", "level", "message" }] }`, for scripts and tools.
- `npm run probe` skips web search in free mode. In credits mode it makes one paid web search on each search provider (about $0.00525 with the defaults) and a few chat calls. It prints shortened responses, without tokens or signed links.
- `npm run calibrate` runs a few fixed requests (game talk, news questions and two that must be blocked) through the safety screen exactly as the bot does, and prints each verdict, with the score for the blocked ones. It needs a complete `.env`, calls Workers AI directly, and exits with an error if any verdict is not the expected one. Use it after you change `GUARD_THRESHOLD`. The expected verdicts assume the default `GUARD_BLOCK`.

## Keeping gork online

gork runs on the computer you set it up on, so it is online only while that computer is on. When the computer sleeps or shuts down, gork goes offline, and it comes back by itself when Docker or Podman starts again. Running gork also uses that computer's power.

To keep it online all the time, run it on something that stays on:

- A spare computer, an old laptop, or a Raspberry Pi 4 or 5 (gork's image works on 64-bit ARM). Costs nothing extra.
- A small rented server (a VPS) from any provider. The smallest plans, typically a few dollars a month, are plenty.
- Cloudflare Containers. gork is not set up for this yet, and it is not the cheapest option: Containers need the $5/month Workers Paid plan, and an always-on container on top of that comes to roughly $7 to $12 a month in total (from [Cloudflare's pricing](https://developers.cloudflare.com/containers/platform/pricing/), October 2026).
