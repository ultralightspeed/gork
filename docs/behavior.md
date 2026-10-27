# What gork does in your server

gork screens what it reads and writes for harmful content. Besides writing a reply, it can ping people, create, change and delete events, post polls and images, and show link previews. Each of these is limited by the permissions the person asking has. @everyone also needs the asker to say "everyone".

## Safety

gork screens every request and every reply before anything is posted.

- The request is screened, along with the message it replies to, any images, and the frames and speech of any video.
- An image posted earlier in the chat is screened when gork asks to see it, before gork is shown it.
- The reply is screened, including any poll text, the name, place and description of an event it creates or changes, and the note naming an event it deletes. Every generated image is screened too, before it is posted.

The screen is Cloudflare's Clef-Flash model. It looks for five kinds of content: violent crime, sex crimes, sexual content involving minors, weapons of mass harm, and self-harm. Change what it checks with `GUARD_BLOCK` and how strict it is with `GUARD_THRESHOLD`. The check for sexual content involving minors is always on, whatever `GUARD_BLOCK` says.

- A blocked request earns the asker a strike. At 3 strikes in 24 hours, gork ignores that person until the strikes age out (`STRIKE_LIMIT`; `0` turns muting off). A strike counts only the asker's own words and images, not the message they replied to or an image posted earlier in the chat. Strikes are kept in memory, so a restart clears them.
- For self-harm, gork does not answer. It sends a fixed, caring reply that points to a crisis line. A persona cannot change it. This holds for an image posted earlier in the chat too, when gork asks to see it.
- The screen fails closed. If it is down or its answer cannot be read, gork posts nothing it wrote and says its safety check is down, or, when Workers AI's free daily allowance is what ran out, that it can't answer until 00:00 UTC. If a generated image cannot be checked, the image is dropped and the reply says so. If an image from earlier in the chat cannot be checked, gork isn't shown it and says it can't see it.

The screen is not a full moderation system. It does not look for hate, harassment, misinformation, adult content between adults, or copyright problems. gork treats chat text and web pages as information to weigh, not as instructions, but no defense against prompt injection is perfect. You stay responsible for your server.

## Pings

By default gork pings nobody. Its replies show names as plain text.

Set `MENTIONS` in `.env` to let it ping. Use `none`, `all`, or a comma-separated list of these kinds:

| Kind | Lets gork |
|---|---|
| `reply` | Ping the person who asked, when it replies to them. |
| `users` | Ping people in the recent conversation by name, when asked or when it clearly helps. |
| `roles` | Ping a role. |
| `everyone` | Use @everyone or @here, under the rules below. |

`all` means every kind. For example: `MENTIONS=reply,users`. The setup page asks this question too. After you change it, run `npm run up`.

The rules:

- gork pings only what the person asking could ping themselves. A role that members cannot normally mention is a locked role, and gork pings it only if the asker has the Mention Everyone permission in that channel.
- With `users`, gork can ping only people in the conversation: the asker, the author of the message they replied to, the people who wrote the recent messages gork reads, and anyone @mentioned in the question. Bots are left out. If two people share a name, it pings neither.
- gork pings at most 5 people and roles in one reply, counted together.
- `@everyone` and `@here` need all of these:
  - `MENTIONS` includes `everyone` (or is `all`).
  - The person asking has the Mention Everyone permission in that channel. In a thread, the parent channel's permissions count.
  - The asker's own message says everyone, everybody, `@everyone`, `@here` or announce, in any wording ("tag everyone", "try tagging everyone again", "announce: raid at 9").
  - The model decides to call its `ping_everyone` tool for that reply.
  - The bot also has the Mention Everyone permission. Discord will not ping without it.
- Without all of that, `@everyone` shows as plain text and pings nobody.
- Only the first message of a long reply can ping. If the pings would make that first message too long for Discord, none of them ping.

The setup page's invite link asks for the Mention Everyone permission only when your `MENTIONS` answer includes `everyone`. The by-hand link in [setup.md](setup.md#setting-up-by-hand) does not. If you turn on `everyone` later, the bot may already have the permission, because some servers give it to every member through the @everyone role. If not, give the bot's role the Mention Everyone permission in your server's role settings.

## Events

Ask gork to schedule something and it creates a native Discord event, then posts the link:

> @gork set up a raid this Friday at 8pm in Raid Voice

It can also tell you what's coming up, and change or delete an event:

> @gork what events do we have this week?
>
> @gork move the raid to Saturday, same time
>
> @gork cancel movie night

A new event shows in the server's Events list, visible to members of the server only. gork creates, changes or deletes an event right after its reply is posted. Then it posts the event's link (after a new event or a change) or a note naming the deleted event, as a second message. A reply does one of these at most: one event created, changed or deleted.

### Who can ask

gork does to an event only what the person asking could do themselves, and what gork's own permissions allow. Discord's rules decide both.

- **Creating** an event needs Create Events on the server, for the person asking and for gork (Administrator includes it). Manage Events alone is not enough.
- **Changing or deleting** an event needs Manage Events, or Create Events for an event you made yourself. The person asking and gork each need it. Discord counts an event gork made as gork's, so changing one needs Manage Events, even for the person who asked for it.
- gork's invite link in [setup.md](setup.md#setting-up-by-hand) asks for Create Events and leaves out Manage Events, so gork can change and delete only the events it made. To let it change other people's events, give its role Manage Events.
- A deleted event can't be brought back, and the list of who was interested goes with it. gork says in its reply which event it deletes and when it was, and posts a note naming it afterwards.
- There is no wording check: gork works out from the conversation what you want ("cancel movie night", "get rid of the raid"). A web page or chat message could in principle talk gork into creating, changing or deleting an event, but only one the person asking may create, change or delete themselves, one per reply, screened, and named in gork's reply. A deletion can't be undone, so it is the larger risk; it is accepted, within those limits.

If either of you lacks a permission, gork says which and does nothing. It is told this before it answers, so it does not claim to have done it. `npm run doctor` warns when gork lacks Create Events.

### Which events gork lists

gork's reply can be read by everyone in the channel, so it lists only events every member of the server can see: every event at a location, and those in voice and Stage channels that the @everyone role can view (and that you and gork can see). It never lists events in other channels, nor says whether there are any. You can still have one changed or deleted by giving its link. In a server where @everyone can't see the voice channels, only events at a location are listed.

### Voice and Stage channels

- To hold a new event in a voice channel, the person asking and gork each need View Channel, Connect and Create Events in that channel. Channel permission overrides count.
- To change or delete an event in a voice channel, each of you needs View Channel and Connect there, along with the permissions above. To move an event into a voice channel, each of you needs all of those in the new channel.
- gork never moves an event out of a channel that not every member can see, so a change never shows an event to more people. Move those in Discord.
- A Stage channel needs more, because Discord asks for it: View Channel, Manage Channels, Mute Members and Move Members, and Create Events for a new event. gork's invite does not include the Stage permissions, so unless you grant them to gork yourself, an event for a Stage channel is created with the channel's name as its location, and gork can't change, delete or move an event into a Stage channel.

### Where and when

- If you name a voice channel, the event is held in it. If you name a place (a town, a game location, a link), that text is the location. If you name neither, the location is `Discord`. Give one or the other.
- gork looks a voice channel up by name. For a new event, if there is no channel with that name, or you or gork can't use it as above, that name becomes the event's location instead. A move doesn't do that: gork says there is no such channel it may move the event to, and changes nothing. A Stage channel gets a Stage event only when both of you have the Stage permissions above.
- People say "Friday 8pm", so gork needs a clock to read it by. Set `TIMEZONE` in `.env` to an IANA name such as `America/New_York` (default `UTC`) and run `npm run up`. gork is told the current date, weekday and time in that zone on every reply.
- When the clocks go forward, a time that gets skipped (2:30 in the morning, say) doesn't exist, so gork asks again. When they go back, a time that happens twice means the first one.
- An event at a location ends 2 hours after it starts unless the asker gives an end time. An event in a voice channel has no end unless one is asked for.
- Moving an event's start moves its end too, so it keeps its length, unless a new end is given.
- The start must be at least 5 minutes away and within 365 days. The name is up to 100 characters, the location up to 100, the description up to 1,000.
- gork can't change an event that is already under way, though it can delete one.
- A repeating event's time and place belong to every time it repeats, so gork changes only its name and description, and doesn't delete it. It also refuses a link to one time of a repeating event. Do those in Discord, where you can also cancel just one time.

### Screening and records

The name, location, voice channel name and description of a new event are screened together with gork's reply, and so is any new text a change gives an event, and the note gork posts after deleting one. If the reply is blocked, nothing is created, changed or deleted. If the reply couldn't be posted, no event is changed or deleted.

Just before it changes or deletes an event, gork reads the event from Discord again and checks your permissions and its own once more, as Discord last sent them. gork sends Discord an audit-log reason with each new event and each change: "Created by gork for" or "Changed by gork for", and the asker's username. Discord takes no reason with a deletion, so the server's audit log shows only that gork deleted the event. gork's own log has a line `event <id> deleted for <username>(<user id>)`.

Each event tool call (create, list, change, delete) counts toward `MAX_TOOL_CALLS`, and none costs anything extra. If Discord refuses, gork posts a short note, and the log has a line starting with `event failed` (creating) or `event change` (changing or deleting).

## Polls

gork posts a native Discord poll when the person asking has the Send Polls permission in that channel. As with events there is no wording check. gork needs Send Polls too, and its invite asks for it. One poll per reply. The question is up to 300 characters, with 2 to 10 answers of up to 55 characters each, and the poll runs for 24 hours unless the asker gives another length (up to 32 days). The poll's question and answers are screened together with gork's reply.

## Web search

In credits mode gork can search the web when an answer depends on current facts. A reply's first search goes to the provider in `SEARCH_PROVIDER` (Ceramic by default, cheap). Its further searches go to the one in `SEARCH_FALLBACK` (Linkup by default, better on new things but 20 times the price): gork searching again is the sign that the first results missed. A first search that fails on the provider's side or finds nothing is retried once on the fallback in the same step, which doesn't count as another tool call. The fallback is used at most 2 times in one reply and `SEARCH_FALLBACK_PER_DAY` times a day (20 by default; the count restarts with gork, and the daily budget caps all spending); after that, and when the day's budget won't cover it, gork uses the provider in `SEARCH_PROVIDER`. A second search in one step (a retry, or the first provider after a failed fallback) starts only if it can finish before the reply's deadline. Every result can be opened with a page read, whichever provider found it.

The log line for each reply shows the searches as `search=<SEARCH_PROVIDER>+<SEARCH_FALLBACK>`, for example `search=1+1`. Search problems are logged with the provider and status, such as `web_search: ceramic found nothing; retried on linkup`, never with the query.

## Images

gork sees the images attached to the question and to the message it replies to. Images posted earlier in the chat are listed to it by number, and it looks at one only when the question is about it, such as "what is this?" right after someone posts an image: at most 4 in a reply, each screened first. One that fails the screen, or can't be checked, isn't shown, and gork says it can't see it. Earlier images aren't offered when the model can't see images (free mode) or tool calls are off (`MAX_TOOL_CALLS=0`).

gork can generate an image from a description. It posts the image only when the person asking has the Attach Files permission in that channel, and gork does too. Every generated image is screened before it is posted. If the screen blocks it or can't check it, the image is dropped and the reply says so.

## Link previews

Discord shows a preview card for a link by fetching the page itself. A reply from gork keeps its previews only when the person asking has the Embed Links permission in that channel and every link in the reply came from the question or the message it replies to. Otherwise gork turns previews off for that message, so a link found on a web page can't make Discord fetch it.
