# Security policy

## Report a vulnerability

Please report security problems privately. Do not open a public issue or pull request for them.

Use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem and how to reproduce it.

Please include:

- What you found and why it matters.
- The steps to reproduce it, with the settings you used (names and values, but never your tokens).
- The version or commit you tested.

gork has one maintainer, who will reply as soon as they can; there is no promised response time. Please allow a reasonable time for a fix before you share the problem.

## Never post secrets

Do not put tokens or keys in an issue, a pull request, a log excerpt or a screenshot. This covers:

- Your Discord bot token (`DISCORD_TOKEN`).
- Your Cloudflare tokens (`CF_RUN_TOKEN`, `CF_ADMIN_TOKEN`) and any other API key (`LLM_API_KEY`).
- Your `.env` file.
- The output of `docker compose config`, which prints your settings.

If you pasted a secret anywhere public, treat it as leaked. Reset or delete it right away in the Discord Developer Portal or the Cloudflare dashboard, then make a new one.

## What is in scope

- Prompt injection that gets past the safety screen: text in a message, a replied-to message, an image or a web page that makes gork post content the screen should block, or makes it follow instructions from untrusted text.
- Token exposure: anything that prints, logs, sends or stores a Discord or Cloudflare secret where it should not be. This includes the admin token entering the container, or a token being sent to a host that is not Cloudflare or the model provider you chose.
- Unwanted pings or actions: any way to make gork ping people, roles, `@everyone` or `@here`, or create an event, poll or image, when the `MENTIONS` setting, the asker's own request or the asker's permissions should have stopped it.
- Getting around the cooldown, the strike mute, the daily budget or the tool limits in a way that costs the person running gork money or harms a server.
- Making gork fetch private, local or internal addresses, or read files it should not.
- A crafted video file that makes ffmpeg use too much memory or time, read something other than Discord's CDN, or slip past the safety screen.

## Known limits

- ffmpeg runs inside gork's container, as the same user as the bot. A code-execution bug in ffmpeg, triggered by a crafted video, could read the bot's Discord and Cloudflare tokens. It is a deliberate trade for simplicity. To limit it, gork:
  - uses a trimmed ffmpeg build that understands only a few common formats;
  - only fetches videos from Discord's own CDN over verified TLS, with no redirects;
  - caps the duration, size, resolution and memory per allocation;
  - runs one ffmpeg at a time with a hard time limit.

  The model can also ask for one short window of the same video to be read again (the `video_frames` tool). That read uses the same limits, the same gate and the same Discord-only URL; the model never supplies a URL, and `MAX_TOOL_CALLS` bounds how many reads one reply can make.

  If that risk is too much for your server, set `VIDEOS_PER_DAY=0`.

- FFmpeg, OpenSSL, LAME and dav1d are built from source, so no package scanner sees them. Their versions are labelled on the image (`org.gork.ffmpeg` and the like), so you can check what you run. They are updated by hand, in a new release, when one of them has a security fix that affects gork.

## What is out of scope

- Problems that need the `.env` file, the container engine or the computer running gork to be compromised already.
- Content the safety screen is not built to catch (it covers five categories; see [docs/behavior.md](docs/behavior.md#safety)).
- A model giving a wrong or odd answer without a security effect.
- Problems in Discord, Cloudflare, Docker or another outside service. Report those to the vendor.
- Running gork in ways [docs/audit.md](docs/audit.md#least-privilege) advises against, such as giving the bot the Administrator permission.

## Auditing gork

[docs/audit.md](docs/audit.md) lists what gork claims about its network access, secrets, files, subprocesses and Discord permissions, with the file or test that backs each claim. [AGENTS.md](AGENTS.md) has the rules for AI agents that install or change gork.

## Supported versions

Only the latest release gets fixes. Security fixes come out as a new release; [Updating gork](docs/setup.md#updating-gork) says how to get it and how to be told when one appears.
