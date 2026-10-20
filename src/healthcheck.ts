// The image's HEALTHCHECK: exit 0 when the bot's heartbeat file is fresh, 1 when it is stale or missing.
// `node src/healthcheck.ts [file]`; the optional file is for tests. The image has no shell, so this is run by node.
import { HEARTBEAT_FILE, heartbeatFresh, readHeartbeat } from "./heartbeat.ts";

const content = readHeartbeat(process.argv[2] ?? HEARTBEAT_FILE);
const fresh = heartbeatFresh(content, Date.now());
console.log(fresh ? "healthy: heartbeat is fresh" : "unhealthy: heartbeat is stale or missing");
process.exit(fresh ? 0 : 1);
