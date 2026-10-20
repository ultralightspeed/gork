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
 * Whether someone may hold an event in a voice or Stage channel, by what Discord asks for when creating one there:
 * a voice event needs View Channel, Connect and Create Events; a Stage event needs Create Events, Manage Channels,
 * Mute Members and Move Members. Pass the channel's own permissions so overrides count.
 */
export const canHoldEvent = (has: (permission: Permission) => boolean, stage: boolean): boolean =>
  canCreateEvents(has) &&
  (stage
    ? has("ViewChannel") && has("ManageChannels") && has("MuteMembers") && has("MoveMembers")
    : has("ViewChannel") && has("Connect"));
