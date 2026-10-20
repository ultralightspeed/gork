// Which image `npm run up` runs: the released one downloaded from GitHub, one you named, or one built on this computer.
import { readFileSync } from "node:fs";

/**
 * Where releases are published (.github/workflows/image.yml pushes <owner>/gork, multi-arch, on every v* tag). Fully
 * qualified, because Podman has no default registry, and lowercase, because GHCR refuses capitals.
 */
export const IMAGE_REPO = "ghcr.io/ultralightspeed/gork";

/** Layered over compose.yaml to run a downloaded image instead of building one. */
export const IMAGE_FILE = "compose.image.yaml";

export type ImagePlan = { mode: "build" } | { mode: "pull"; ref: string; custom: boolean };

/**
 * The image to run. `setting` is GORK_IMAGE: blank for the release matching `version`, "build" to build here, or the
 * name of an image to run (custom: chosen by you, so it is never replaced by a build or removed by destroy).
 * `forceBuild` is `npm run up -- --build`, which beats everything.
 *
 * The release is pinned to this checkout's version rather than `latest`: the image then matches the settings table and
 * compose.yaml next to it, and a version that was never published falls back to building this very checkout.
 */
export function chooseImage(setting: string, forceBuild: boolean, version: string): ImagePlan {
  if (forceBuild || setting === "build") return { mode: "build" };
  if (setting) return { mode: "pull", ref: setting, custom: true };
  return { mode: "pull", ref: `${IMAGE_REPO}:${version}`, custom: false };
}

/** The version in package.json: the release this checkout belongs to. */
export function packageVersion(): string {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
}
