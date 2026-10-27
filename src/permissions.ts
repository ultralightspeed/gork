/** The Discord permissions gork checks before it answers. */
export type Permission =
  | "SendMessages"
  | "SendMessagesInThreads"
  | "ReadMessageHistory"
  | "AttachFiles"
  | "EmbedLinks"
  | "SendPolls"
  | "ViewChannel"
  | "Connect"
  | "ManageChannels"
  | "MuteMembers"
  | "MoveMembers"
  | "CreateEvents"
  | "ManageEvents";

/** Whether someone may create scheduled events. Manage Events alone doesn't: Discord's create call asks for Create Events. */
export const canCreateEvents = (has: (permission: Permission) => boolean): boolean => has("CreateEvents");

/**
 * What gork may do in a channel for this asker. Answering needs only gork's permissions (a thread needs Send Messages
 * in Threads instead of Send Messages). Files and polls need the permission on both sides, so nobody gets gork to post
 * what they couldn't, and link previews need the asker's Embed Links.
 */
export function channelAbilities(
  botHas: (permission: Permission) => boolean,
  askerHas: (permission: Permission) => boolean,
  inThread: boolean,
): { send: boolean; attach: boolean; poll: boolean; embeds: boolean } {
  const both = (p: Permission) => botHas(p) && askerHas(p);
  return {
    send: botHas(inThread ? "SendMessagesInThreads" : "SendMessages") && botHas("ReadMessageHistory"),
    attach: both("AttachFiles"),
    poll: both("SendPolls"),
    embeds: askerHas("EmbedLinks"),
  };
}

/**
 * What Discord asks for in a voice or Stage channel to create, change or delete an event held there, besides the
 * event permissions: View Channel and Connect for a voice channel; View Channel, Manage Channels, Mute Members and
 * Move Members for a Stage channel. Pass the channel's own permissions so overrides count.
 */
export const canUseEventChannel = (has: (permission: Permission) => boolean, stage: boolean): boolean =>
  stage
    ? has("ViewChannel") && has("ManageChannels") && has("MuteMembers") && has("MoveMembers")
    : has("ViewChannel") && has("Connect");

/** Whether someone may hold a new event in a voice or Stage channel: Create Events, and what the channel asks for. */
export const canHoldEvent = (has: (permission: Permission) => boolean, stage: boolean): boolean =>
  canCreateEvents(has) && canUseEventChannel(has, stage);

/** What stops someone changing or deleting an event (see eventChangeBlock), or null when nothing does. */
export type EventChangeBlock = "manage" | "create" | "channel" | null;

/**
 * What stops someone changing or deleting an event, by Discord's rule, or null when nothing does. An event someone
 * else made needs Manage Events ("manage"); one of their own needs Create Events or Manage Events ("create"). An event
 * in a voice or Stage channel also needs what canUseEventChannel asks for there ("channel"). Pass the event channel's
 * own permissions so overrides count, or the server's for an event at a location.
 */
export function eventChangeBlock(
  has: (permission: Permission) => boolean,
  { own, channel }: { own: boolean; channel: "none" | "voice" | "stage" },
): EventChangeBlock {
  if (!(has("ManageEvents") || (own && has("CreateEvents")))) return own ? "create" : "manage";
  if (channel !== "none" && !canUseEventChannel(has, channel === "stage")) return "channel";
  return null;
}
