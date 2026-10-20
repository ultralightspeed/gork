---
# Copy this file to personas/custom.md and edit it. Lines starting with # are
# comments and are ignored. Everything after the closing --- is sent to the model
# as the persona, so replace every [bracketed placeholder] before you use it.
#
# Front matter keys (all optional; one line each, written as key: value):
#   name          Bot name, substituted for {name} in the body. Defaults to gork.
#   description   One line shown in the setup page's personality list.
#   quirk         One instruction for the occasional "bit" added after the answer.
#                 Example: After the answer, add one short jab in character.
#   quirk_rate    Share of replies that get the quirk, from 0 to 1 (0.3 = about 3 in 10).
#                 Leave out quirk and quirk_rate if you don't want a recurring bit.
#   reply.busy           Sent when the bot is still answering the previous message.
#   reply.cooldown       Sent when a user is on cooldown. {seconds} becomes the wait.
#   reply.empty          Sent when someone pings the bot with no question.
#   reply.error          Sent when something breaks.
#   reply.out_of_budget  Sent when the daily budget is used up.
#   reply.blocked        Sent when a request is refused.
#   reply.empty_answer   Sent when the model returns no text.
#   reply.no_attach      Appended when an image was made but files can't be uploaded here.
#   reply.no_poll        Appended when a poll was made but polls can't be posted here.
#   reply.no_event       Appended when an event was made but you or the bot can't create events here.
#   reply.event_failed   Sent when Discord refused to create the event.
#   Leave any reply.* key out to use the built-in wording. Keep each value on one line.
#   Safety messages are not configurable here; the bot always handles them itself.
#
# How to write the body:
#   - Say who the bot is, how it talks (sentence length, slang, capitalization,
#     emoji), and what kind of humor it has. A few short bullets is enough.
#   - Add 3 to 4 voice examples. They show tone; the bot should not copy their wording.
#   - Don't restate the bot's built-in rules (accuracy, tools, mentions, length cap,
#     safety). The bot adds those itself, and repeating them only bloats the prompt.
#
name: gork
description: [One line describing your persona.]
---
You are {name}. [Who they are, in one or two sentences.]

- [How they talk: length, slang, capitalization, emoji.]
- [Their humor and attitude.]
- [Anything they should never do.]

Voice examples (tone only, don't copy the wording):
- "[sample message]" → "[sample reply]"
- "[sample message]" → "[sample reply]"
- "[sample message]" → "[sample reply]"
