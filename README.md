<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img alt="gork, the @grok of your Discord server" src="assets/banner-light.svg" width="640">
  </picture>
</p>

<p align="center">
  <b>Mention it. Ask it anything.</b><br>
  An ultralight-cost, self-hosted Discord bot that fact-checks, searches the web, reads links, videos and images,<br>
  and makes images, polls and events. It runs on your own computer, for your own server.
</p>

<p align="center">
  <a href="https://github.com/ultralightspeed/gork/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ultralightspeed/gork/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: 0BSD" src="https://img.shields.io/badge/license-0BSD-blue"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-gork-can-do">Features</a> ·
  <a href="#what-it-costs">Costs</a> ·
  <a href="docs/audit.md#privacy">Privacy</a> ·
  <a href="docs/setup.md">Setup guide</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a>
</p>

<p align="center">
  <img alt="A Discord chat: someone asks @gork whether the Great Wall of China is visible from space, and gork answers False with a source." src="assets/demo.svg" width="720">
</p>

## What gork can do

Reply to any message with `@gork is this true?`, or just ask it something. It reads the message you replied to and the recent chat, then answers in the thread.

- Fact-checks claims and searches the web for current facts.
- Reads web pages people share.
- Watches short videos posted in Discord, up to 60 seconds: frames and speech.
- Reads YouTube transcripts from a video link. This uses an undocumented YouTube interface that can break at any time; when it does, gork says transcripts are unavailable and everything else keeps working.
- Sees images, link previews and forwarded messages.
- Generates images from a description.
- Makes native Discord polls and events, in your time zone.
- Talks in one of five personalities, or one you write in the setup page.
- Screens every request and reply for harmful content, and posts nothing if the screen is down.

gork is built for a small private server of people you know. You run it yourself; nobody else hosts it for you. It is not a public multi-server bot.

## Quickstart

```sh
# 1. Get gork
git clone https://github.com/ultralightspeed/gork.git
cd gork

# 2. Start Docker or Podman, then open the setup page in your browser
npm run setup
```

No coding and no `npm install` needed: `npm run setup` uses only what comes with Node, and gork's own packages come inside its container image. No git? Use the green **Code** button above, then **Download ZIP**.

You need:

- A computer that stays on while you want gork online. A Windows, Mac or Linux PC is fine.
- Docker or Podman with Compose, installed and running. Only the command-line tools are needed, not a Desktop app. On Windows and Mac, [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Podman Desktop](https://podman-desktop.io/) is the easy way to get them. On Linux, Docker Engine with the Compose plugin, or Podman 4.7 or newer with docker-compose or podman-compose, is enough. Anything else that gives you a working `docker compose` (OrbStack, Colima, Rancher Desktop and so on) works the same way, since those are the only commands gork runs. Docker must be 23 or newer, which reads the image's compressed layers. gork uses Docker if it works and Podman otherwise.
- [Node.js](https://nodejs.org/) 24 or newer. The `npm` command comes with it.
- A Discord account, and a server where you can add bots.
- A free Cloudflare account. Sign up at <https://dash.cloudflare.com/sign-up>.

`npm run setup` opens a page in your web browser (or prints an address to copy into it). The page walks you through setup one step at a time:

1. Choose how gork pays for the model (free or credits, see below), its personality, who it may mention and your time zone.
2. Create the bot in Discord and paste its token into the page. The page turns on the settings gork needs and shows you the server gork joined so you can confirm it.
3. Create a one-time Cloudflare setup token and paste it into the page. The page creates two Cloudflare tokens limited to what gork needs, sets up the AI Gateway, tests everything, and deletes the setup token.
4. Click **Save the settings**, which writes your `.env` file, then **Start gork**.

Starting gork downloads its ready-made image from GitHub, which takes a few minutes. If the download fails, gork builds the image on your computer instead, which compiles FFmpeg and takes 15 to 30 minutes (longer on a Raspberry Pi). When the page says gork is online, go to your server and write `@gork hello`. Leave the terminal window open until then.

Later, `npm run up` starts gork again and `npm run down` stops it. [docs/setup.md](docs/setup.md) covers every step of the page, setting up by hand, and the everyday commands. If something does not work, run `npm run doctor`, then see [docs/troubleshooting.md](docs/troubleshooting.md).

## What it costs

Usually a cent or two a day. The setup page asks which billing mode you want, and your answer is the `BILLING_MODE` setting.

- Credits mode uses prepaid Cloudflare credits (the minimum top-up is $10). Everything works, including web search. gork stops for the day at a daily budget (`DAILY_BUDGET_USD`, 50 cents by default), and the AI Gateway gets a spend limit of about 1.2 times that as a second line of defense.
- Free mode uses only Cloudflare's free daily Workers AI allowance, on the Workers Free plan, and costs nothing. Its limits: roughly 25 to 100 replies a day, no web search, a smaller model that can't see images (videos give only their transcript), and once the day's allowance is gone gork says so and answers nothing until 00:00 UTC. See [docs/setup.md](docs/setup.md#free-mode-in-detail).

The default model is [GLM-5.3 Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/), an open-weights model from Zhipu (Z.ai) in China, which Cloudflare runs on its own servers. Your messages go to Cloudflare, not to the model's makers. Cloudflare says it [does not use what you send Workers AI to train models](https://developers.cloudflare.com/workers-ai/platform/data-usage/) and does not keep it after answering. You can switch models with `LLM_MODEL`; then also set `LLM_PRICE_IN_PER_M` and `LLM_PRICE_OUT_PER_M` to that model's prices, because gork's daily cap is only as accurate as those numbers.

Rough prices (they change, so check Cloudflare's pricing pages):

| What | Cost |
|---|---|
| A normal reply (default model) | about $0.001 to $0.002 |
| One web search | $0.00025 ($0.25 per 1,000 searches) |
| Page reads, YouTube transcripts, polls, events | nothing extra |
| Safety check, generated images, video speech-to-text | see below; on Workers Paid about $0.0005 for the speech in a full 60-second clip |

The safety check, image generation and video speech-to-text call Workers AI directly, in both modes. They never use your credits, and the gateway's spend limit does not cover them. On the Workers Free plan they use the free daily allowance and cost nothing. On Workers Paid, Cloudflare bills what goes past that allowance.

At the default 50-cent cap, gork can answer roughly 250 to 500 simple replies a day, so $10 of credits covers about 5,000 to 10,000 replies. A reply that searches several times or reads a long transcript costs more. Keep auto top-up off in Cloudflare: on the Workers Free plan your credit balance is then the most a leaked token could spend. On Workers Paid, a leaked runtime token could also run Workers AI models directly, billed to your account, so delete it in the Cloudflare dashboard if it leaks. Cloudflare may charge a small fee when you buy credits.

## More

- [Setup guide](docs/setup.md): the setup page step by step, setting up by hand, Docker or Podman, free mode, everyday commands, and keeping gork online.
- [What gork does in your server](docs/behavior.md): the safety screen, pings (`MENTIONS`), events (`TIMEZONE`), polls, images and link previews.
- [Personalities](docs/personalities.md): the five presets and how to write your own.
- [Privacy and auditing](docs/audit.md): what leaves your computer and where it goes. When someone mentions gork, recent messages from that channel go to Cloudflare, so tell your server members.
- [Troubleshooting](docs/troubleshooting.md).
- Settings: every setting is in `.env`, and [`.env.example`](.env.example) lists them all with defaults. After you change `.env`, run `npm run up` again.
- [CONTRIBUTING.md](CONTRIBUTING.md) to work on gork, [SECURITY.md](SECURITY.md) to report a vulnerability, and [AGENTS.md](AGENTS.md) for AI coding agents that install or change gork.

## License

Everything in the universe is in the public domain, including this bot.

gork is released under the [Zero-Clause BSD license](LICENSE) (0BSD), a public-domain-equivalent license. Use it for anything; no attribution needed.

gork is not affiliated with xAI or X.
