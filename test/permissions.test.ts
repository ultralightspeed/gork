import { describe, expect, it } from "vitest";
import { canCreateEvents, canHoldEvent, channelAbilities, type Permission } from "../src/permissions.ts";

const has =
  (...granted: Permission[]) =>
  (p: Permission) =>
    granted.includes(p);

describe("channelAbilities", () => {
  const all = has("AttachFiles", "SendPolls", "EmbedLinks");
  const gork = (bot: (p: Permission) => boolean, inThread = false) => channelAbilities(bot, all, inThread);

  it("needs Send Messages and Read Message History to answer in a channel", () => {
    expect(gork(has("SendMessages", "ReadMessageHistory")).send).toBe(true);
    expect(gork(has("SendMessages")).send).toBe(false);
    expect(gork(has("ReadMessageHistory")).send).toBe(false);
  });

  it("asks for Send Messages in Threads instead inside a thread", () => {
    expect(gork(has("SendMessagesInThreads", "ReadMessageHistory"), true).send).toBe(true);
    expect(gork(has("SendMessages", "ReadMessageHistory"), true).send).toBe(false);
    expect(gork(has("SendMessagesInThreads", "ReadMessageHistory")).send).toBe(false);
  });

  it("answers whatever the asker's own permissions", () => {
    expect(channelAbilities(has("SendMessages", "ReadMessageHistory"), has(), false).send).toBe(true);
  });

  it("allows files and polls only with their own permission", () => {
    expect(gork(has("AttachFiles"))).toMatchObject({ attach: true, poll: false });
    expect(gork(has("SendPolls"))).toMatchObject({ attach: false, poll: true });
    expect(channelAbilities(has(), has(), false)).toEqual({ send: false, attach: false, poll: false, embeds: false });
  });

  it("allows files and polls only when the asker has the permission too", () => {
    const bot = has("AttachFiles", "SendPolls");
    expect(channelAbilities(bot, has("AttachFiles"), false)).toMatchObject({ attach: true, poll: false });
    expect(channelAbilities(bot, has("SendPolls"), false)).toMatchObject({ attach: false, poll: true });
  });

  it("allows link previews only when the asker has Embed Links", () => {
    expect(channelAbilities(has(), has("EmbedLinks"), false).embeds).toBe(true);
    expect(channelAbilities(has("EmbedLinks"), has(), false).embeds).toBe(false);
  });
});

describe("canCreateEvents", () => {
  it("needs Create Events, and Manage Events alone is not enough (Discord's create call asks for Create Events)", () => {
    expect(canCreateEvents(has("CreateEvents"))).toBe(true);
    expect(canCreateEvents(has("ManageEvents"))).toBe(false);
    expect(canCreateEvents(has("SendMessages", "SendPolls", "ViewChannel"))).toBe(false);
    expect(canCreateEvents(has())).toBe(false);
  });
});

describe("canHoldEvent", () => {
  it("lets a voice channel hold an event for someone who can see it, connect to it and create events there", () => {
    expect(canHoldEvent(has("ViewChannel", "Connect", "CreateEvents"), false)).toBe(true);
    expect(canHoldEvent(has("Connect", "CreateEvents"), false)).toBe(false);
    expect(canHoldEvent(has("ViewChannel", "CreateEvents"), false)).toBe(false);
    expect(canHoldEvent(has("ViewChannel", "Connect"), false)).toBe(false);
  });

  it("asks more of a Stage channel: Manage Channels, Mute Members and Move Members, not Connect", () => {
    const stage = ["ViewChannel", "CreateEvents", "ManageChannels", "MuteMembers", "MoveMembers"] as const;
    expect(canHoldEvent(has(...stage), true)).toBe(true);
    for (const missing of stage) {
      expect(canHoldEvent(has(...stage.filter((p) => p !== missing)), true), missing).toBe(false);
    }
    expect(canHoldEvent(has("ViewChannel", "Connect", "CreateEvents"), true)).toBe(false);
  });
});
