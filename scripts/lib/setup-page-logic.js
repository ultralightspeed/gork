// The setup page's decisions, kept out of its DOM code so tests can run them in Node. The server pastes this file into
// the page's one script with the `export` words removed, so it holds only top-level functions and constants.

/** Only an https address the server supplied ever becomes a link; anything else gives null. */
export function safeHref(url) {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/** A message split at each `backticked` span, so the page can show commands as code: [{ text, code }]. */
export function codeParts(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), code: false });
    parts.push({ text: m[1], code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push({ text: text.slice(last), code: false });
  return parts;
}

/** What the hint under a secret box says while it is being typed in (nothing is sent anywhere). */
export function secretHint(kind, value) {
  const v = value.trim();
  if (kind === "discord") {
    if (!v)
      return { level: "", text: "Paste the token here (Ctrl+V, or right-click and Paste, or press the Paste button)." };
    if (/^[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}$/.test(v))
      return { level: "ok", text: "✓ This looks like a Discord bot token." };
    if (/\s/.test(v)) return { level: "bad", text: "There is a space or line break in it. Copy just the token." };
    return {
      level: "bad",
      text: "That doesn't look like a bot token yet. A bot token has two dots, like xxxx.yyyy.zzzz. On the Bot page click Reset Token and copy what it shows.",
    };
  }
  if (!v)
    return { level: "", text: "Paste the secret here (Ctrl+V, or right-click and Paste, or press the Paste button)." };
  if (/\s/.test(v)) return { level: "bad", text: "There is a space or line break in it. Copy just the secret." };
  if (v.includes(".")) {
    return {
      level: "bad",
      text: "That has dots in it, so it looks like a Discord token, not a Cloudflare one. Copy the secret Cloudflare shows after Create Token.",
    };
  }
  if (v.length < 20) return { level: "bad", text: "That looks too short. Copy the whole secret." };
  return { level: "ok", text: "✓ This looks like a Cloudflare token." };
}

const NAME_SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.'’-]*$/u;

/** The hint under the custom personality's name: empty while the name is empty or fine. */
export function nameHint(name) {
  const n = name.trim();
  const ok = n === "" || NAME_SHAPE.test(n);
  return {
    level: ok ? "" : "bad",
    text: ok ? "" : "Letters, numbers, spaces and - _ . ' only, starting with a letter or number.",
  };
}

/** How many characters are left in a box with this limit. */
export function charactersLeft(value, limit) {
  const left = limit - value.length;
  return {
    level: left < 0 ? "bad" : "",
    text: `${left.toLocaleString()} of ${limit.toLocaleString()} characters left.`,
  };
}

const GATEWAY_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** What the name typed for a new gateway would make, said before anything is created, and whether it may be used. */
export function gatewayPreview(name, gateway) {
  const n = name.trim();
  if (!n) return { level: "", ok: false, text: "Type a name above, or use the suggestion." };
  if (!GATEWAY_SHAPE.test(n)) {
    return {
      level: "bad",
      ok: false,
      text: "Use letters, digits and hyphens only (up to 64), starting with a letter or digit.",
    };
  }
  if (gateway && n.toLowerCase() === gateway.id.toLowerCase()) {
    return { level: "bad", ok: false, text: "That is the gateway you already have. Pick a different name." };
  }
  return { level: "ok", ok: true, text: `Setup will make a new AI Gateway called “${n}”.` };
}

/** A 404 from the page's own API: this server doesn't know the page (setup has closed, or it is another run's). */
export function isClosedAnswer(status) {
  return status === 404;
}

/** Losing contact means setup has closed, unless the person stopped it here or gork is already online. */
export function closedMeansLost(view, stopped) {
  return !(stopped || (view && view.start.status === "online"));
}

/**
 * What to ask the server next, and after how long: `{ path, every }`, or null to stop asking. `ui` is the page's own
 * state: stopped (the person pressed Stop), lost (no answer), pending (an action just started), acked (Continue was
 * pressed past a check that didn't pass).
 */
export function pollKind(view, ui) {
  if (ui.stopped) return null;
  // Lost contact: keep knocking, so the page comes back by itself if setup is still there.
  if (ui.lost) return { path: "state", every: 5000 };
  if (!view) return null;
  // Something is working: follow it closely, so the checklist moves as the steps do.
  if (ui.pending || view.work) return { path: "state", every: 1000 };
  if (view.start.status === "running") return { path: "state", every: 1500 };
  const d = view.discord;
  if (d.app && !d.selected) {
    // A hiccup (Discord busy, no network) is shown, and the look is repeated more slowly.
    const every = d.problem ? 10000 : 3000;
    if (d.publicBot === "on") return { path: "discord/refresh", every };
    if (d.publicBot && !d.guildsProblem) return { path: "discord/refresh", every };
  }
  const c = view.cloudflare;
  if (c.phase === "ready" && c.needsCredits && !ui.acked && !view.finish.written) {
    return { path: "cloudflare/credits", every: 10000 };
  }
  // Otherwise keep in step with the server, so a second copy of this page (or one opened earlier) shows the current
  // step instead of a stale, locked one. A state check doesn't count as activity for the idle timeout.
  return { path: "state", every: 3000 };
}

/** Each card's state ("done", "active" or "locked"), from the server's view and the page's own state. */
export function cardState(view, ui) {
  const choicesDone = !!view.choices && !ui.editingChoices;
  const discordDone = !!view.discord.selected;
  const c = view.cloudflare;
  const cfDone = c.phase === "ready" && (c.probes.every((p) => p.ok) || ui.acked || view.finish.written);
  return {
    choices: choicesDone ? "done" : "active",
    discord: !view.choices || ui.editingChoices ? "locked" : discordDone ? "done" : "active",
    cloudflare: !discordDone || !choicesDone ? "locked" : cfDone ? "done" : "active",
    finish: !cfDone || !discordDone || !choicesDone ? "locked" : "active",
  };
}

/** The checklist a card shows: the server's own, or a "Starting" line from the click until the server's first answer. */
export function workOf(view, pending, id) {
  if (view.work && view.work.id === id) return view.work;
  return pending === id ? { id, steps: [{ label: "Starting", state: "active" }] } : null;
}

/** The one-line summary of the saved answers. */
export function choicesSummary(c) {
  const kinds =
    c.mentions === "none" ? [] : c.mentions === "all" ? ["reply", "users", "roles", "everyone"] : c.mentions.split(",");
  const bits = [
    c.billing === "free" ? "Free mode" : `Credits ($${c.budget} a day)`,
    `${c.persona} personality`,
    kinds.length ? `may ping: ${kinds.join(", ")}` : "pings no one",
    c.timezone,
  ];
  return `✓ ${bits.join(" · ")}`;
}

/**
 * Whether saved answers differ from what Advanced starts with (the default personality, no pings, the browser's time
 * zone, a $0.50 budget), so Advanced opens when they are changed again.
 */
export function advancedChanged(c, zone) {
  const budget = c.billing === "credits" && Number(c.budget) !== 0.5;
  return c.persona !== "default" || c.mentions !== "none" || c.timezone !== zone || budget;
}

/** What the custom personality's last save warned about, while custom is the saved choice. */
export function customWarnings(view) {
  return view.choices && view.choices.persona === "custom" ? view.custom.warnings : [];
}

/** The line under the Public Bot or invite box while the page waits for Discord. */
export function discordWaiting(d, what) {
  if (d.problem) return `${d.problem} Setup keeps trying.`;
  return what === "public"
    ? "Setup checks with Discord every few seconds and ticks this off by itself."
    : "Waiting for gork to join. Setup checks every few seconds and shows your server here.";
}

const PROBE_NAMES = {
  chat: "Talking to the AI model",
  "web search": "Web search",
  "page reading": "Reading web pages",
};

/** One check of gork's run token, as the Cloudflare card lists it. */
export function probeLine(p) {
  return {
    ok: p.ok,
    name: PROBE_NAMES[p.capability] || p.capability,
    detail: `: ${p.kind === "credits" ? "there are no credits yet (see the box below)." : p.message}`,
  };
}

/** What setup did and what still needs attention, for the list at the end. `warn` marks a done thing with a catch. */
export function finishLines(view) {
  const f = view.finish;
  const env = view.envName;
  const lines = [];
  lines.push(
    f.privacy === "owner-only"
      ? { ok: true, warn: false, text: `Settings saved in ${env}. Only your account can read it.` }
      : {
          ok: true,
          warn: true,
          text: `Settings saved in ${env}. Setup couldn't restrict who can read it on this computer, so keep it private and don't share or commit it.`,
        },
  );
  lines.push(
    f.setupToken === "deleted"
      ? { ok: true, text: "The one-time setup token is deleted, and setup checked that it no longer works." }
      : {
          ok: false,
          text: `Setup couldn't confirm the setup token is gone. Open your Cloudflare API tokens (${view.links.tokens}) and delete the one called gork-setup.`,
        },
  );
  if (f.oldTokens) {
    const n = f.oldTokens.revoked;
    lines.push({ ok: f.oldTokens.left.length === 0, text: `Revoked ${n} older gork ${n === 1 ? "key" : "keys"}.` });
    for (const l of f.oldTokens.left) lines.push({ ok: false, text: l });
  }
  if (view.cloudflare.needsCredits) {
    lines.push({
      ok: false,
      text: `There are no AI Gateway credits yet, so gork can't answer until you add some. Add them at ${view.links.credits} (Manage, then Top-up credits).`,
    });
  }
  for (const p of view.cloudflare.probes) {
    if (!p.ok && p.kind !== "credits") lines.push({ ok: false, text: `${p.capability}: ${p.message}` });
  }
  if (view.discord.intent && !view.discord.intent.ok) lines.push({ ok: false, text: view.discord.intent.message });
  for (const w of customWarnings(view)) lines.push({ ok: false, text: w });
  return lines;
}
