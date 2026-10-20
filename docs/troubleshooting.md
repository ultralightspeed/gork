# Troubleshooting

Start with `npm run doctor`. Fix the `FAIL` lines, then run it again. A `warn` line does not stop gork. It also says which container engine it found (Docker or Podman), and fails when neither works.

Then read the logs with `npm run logs`.

## npm run up fails on the AI Gateway

If the message says HTTP 401 or 403, the admin token has probably expired or is missing a permission. An admin token made with "Keep an admin key" turned off in the setup page lasts one hour. Create a new admin token with AI Gateway Read and Write (called Edit on some accounts), put it in `CF_ADMIN_TOKEN`, and run `npm run up` again.

## Docker or Podman problems

`npm run up` says which engine it is using, and what to start when none works. The engine is chosen by `CONTAINER_ENGINE` or, when that is blank, Docker if it works and Podman otherwise (see [setup.md](setup.md#docker-or-podman-and-the-image)).

If the image can't be downloaded, `npm run up` builds it on your computer and says so. The build compiles FFmpeg and takes 15 to 30 minutes (longer on a Raspberry Pi). If you only want the build, run `npm run up -- --build`.

gork's `compose.yaml` is the same for both engines. On some systems, Podman differs in these ways:

- *Cannot connect to the Docker daemon at .../podman.sock* (Linux, with docker-compose): start Podman's API socket with `systemctl --user enable --now podman.socket`, or install podman-compose.
- *the requested cgroup controller `cpu` is not available* (rootless Podman on Linux): `compose.yaml` limits gork to one CPU, and systemd gives ordinary users only the memory and pids controllers. As an administrator, create `/etc/systemd/system/user@.service.d/delegate.conf` containing `[Service]` and `Delegate=cpu cpuset io memory pids`, run `sudo systemctl daemon-reload`, then log out and in again.
- *Permission denied* reading `personas`, or a `persona` FATAL line (Fedora, RHEL and other SELinux systems): the container may not read files in your home folder until they are labelled. Run `chcon -R -t container_file_t personas` in the gork folder, then `npm run up`.
- *gork does not come back after a reboot*: `restart: unless-stopped` only works while Podman runs. On Linux, run `systemctl --user enable --now podman-restart.service` and `loginctl enable-linger $USER`. On Windows and Mac, start the Podman machine (Podman Desktop can do it at login).
- *The container says `starting` and never `healthy`* (Linux without systemd, some WSL setups): Podman runs health checks from systemd timers. gork works anyway, and `npm run up` judges by gork's own log.
- *podman-compose* cannot print its settings as JSON, so `npm run up` skips its check that Node and Compose read `.env` alike. Keep values unquoted and comments on their own lines.
- Podman keeps logs in its own format and honours `max-size` (5 MB) but ignores `max-file`.
- *FATAL `data-dir`* under Podman: a possible cause is a data volume that was created by something else (for example an earlier run as another user) and so isn't owned by the user gork runs as. Podman normally gives a new volume to that user by itself. If you see this, run `npm run down`, remove the volume (`podman volume ls`, then `podman volume rm <folder name>_gork-data`), and run `npm run up`. It only loses today's spend count.

## FATAL lines

If gork hits a problem that restarting cannot fix, it prints one line and then sits idle. This stops Docker from restarting it over and over. Discord limits how often a bot can log in, and going over the limit resets the bot token. `npm run up` shows this line if it happens at startup.

The line looks like `[gork] FATAL <code>: <detail>`.

| Code | What it means | What to do |
|---|---|---|
| `config` | A setting is missing or has a bad value. The detail gives each setting's name, not its value. | Fix `.env`, using `.env.example` as a guide, then run `npm run up`. |
| `data-dir` | gork cannot write its spend file in its data folder. | Run `npm run down`, then `npm run up`. If it repeats, check that Docker can use its data volume. |
| `persona` | The personality named in `PERSONA` was not found. The detail lists the choices. | Fix the name. For `custom`, check that `personas/custom.md` exists. |
| `discord-login` | Discord refused the login. The token is wrong, or Message Content Intent is off. | Reset the token in the Developer Portal, put it in `.env`, and turn on Message Content Intent. |
| `discord-gateway` | Discord closed the connection with a code that retrying cannot fix. Usually a bad token or a missing intent. | Same fixes as `discord-login`. |

After fixing it, run `npm run up`.

## gork does not answer

- Look for `ready as` in the logs. If it is missing, look for a FATAL line.
- Check `GUILD_IDS`. The log says `in non-allowlisted guild` if the server is not listed.
- Check channel permissions. At startup the log lists the channels gork cannot read or answer in. Channel permissions can hide a new bot even when the server permissions look right.
- Check `ALLOWED_CHANNEL_IDS`. If it is set, gork answers only there (and in threads of those channels).
- Mention the bot with a Discord mention (pick it from the list that pops up), not by typing its name.
- Wait out the cooldown (3 seconds by default) between questions.
- If gork says it is out of budget, it reached `DAILY_BUDGET_USD`. It resets at 00:00 UTC.
- If gork says its safety check is down, look for a log line that starts with `guard`. Either the Cloudflare free allowance is used up, or the call failed.
- If replies fail, check your Cloudflare credits. `npm run up` warns when the balance is $0.

## gork won't create events

- If you didn't say what the event is and when, gork asks first. Tell it, or say "do it" to let it pick.
- gork creates an event only when the person asking and gork both have Create Events on the server (Administrator includes it; Manage Events alone does not). It says so when one of you does not. `npm run doctor` warns when gork lacks it. Give its role the permission (Server Settings, Roles), or add it again with the invite link in [setup.md](setup.md).
- For an event in a voice channel, both of you also need View Channel, Connect and Create Events in that channel (a Stage channel needs Manage Channels, Mute Members and Move Members as well). Otherwise the channel name becomes the event's location.
- The times are read in `TIMEZONE` (default `UTC`). If events land at the wrong hour, set it and run `npm run up`.
- If gork posts that it tried and Discord said no, look for `event failed` in the logs. It gives Discord's reason.
- See [behavior.md](behavior.md#events).

## YouTube transcripts stop working

gork reads transcripts through an undocumented YouTube interface. YouTube can change or block it at any time. When that happens gork says transcripts are unavailable right now, and it works again only after a fix to gork. Everything else keeps working.
