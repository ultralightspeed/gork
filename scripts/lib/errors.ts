/** A failure the user can act on (bad .env, Docker down, Cloudflare refused). The CLI prints the message, no stack. */
export class CliError extends Error {}
