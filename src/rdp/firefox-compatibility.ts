/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox's DevTools RDP is not a stable, versioned public protocol. Keep the
// accepted range aligned with the oldest ESR and newest Nightly exercised by
// CI. The scheduled compatibility workflow deliberately opts out of this gate
// so it can test a newly-published Firefox before this range is updated.

import { allowUnsupportedFirefox } from "../config.js";
import type { Logger } from "../logging.js";
import { RdpClient } from "./client.js";
import {
  REQUESTS,
  ROOT_ACTOR,
  type DeviceDescription,
  type GetDescriptionResponse,
  type GetRootResponse,
} from "./protocol.js";

export const MIN_SUPPORTED_FIREFOX_MAJOR = 140;
export const MAX_SUPPORTED_FIREFOX_MAJOR = 157;

export interface FirefoxRuntime {
  version: string;
  major: number;
  channel?: string;
  buildId?: string;
}

export class FirefoxCompatibilityError extends Error {
  override name = "FirefoxCompatibilityError";
}

export function parseFirefoxMajor(version: string): number | undefined {
  const match = /^(\d+)/.exec(version.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export function firefoxCompatibilityError(runtime: FirefoxRuntime): string | undefined {
  if (runtime.major < MIN_SUPPORTED_FIREFOX_MAJOR) {
    return (
      `Firefox ${runtime.version} is too old for firefox-lldb; ` +
      `supported Firefox major versions are ${MIN_SUPPORTED_FIREFOX_MAJOR}–${MAX_SUPPORTED_FIREFOX_MAJOR}.`
    );
  }
  if (runtime.major > MAX_SUPPORTED_FIREFOX_MAJOR) {
    return (
      `Firefox ${runtime.version} is newer than firefox-lldb has validated; ` +
      `supported Firefox major versions are ${MIN_SUPPORTED_FIREFOX_MAJOR}–${MAX_SUPPORTED_FIREFOX_MAJOR}.`
    );
  }
  return undefined;
}

/** Read Firefox application metadata from the RDP device actor. */
export async function detectFirefoxRuntime(client: RdpClient): Promise<FirefoxRuntime> {
  const root = (await client.request(ROOT_ACTOR, {
    type: REQUESTS.getRoot,
  })) as GetRootResponse;
  if (!root.deviceActor) {
    throw new FirefoxCompatibilityError(
      "Firefox RDP root actor has no deviceActor; cannot determine compatibility"
    );
  }

  // On headless macOS the device actor can become reachable just before its
  // window's displayDPI is initialized, and getDescription temporarily throws
  // NS_ERROR_FAILURE. Keep this startup-only retry local to metadata discovery;
  // retrying arbitrary RDP operations could hide a real protocol break.
  let response: GetDescriptionResponse | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      response = (await client.request(root.deviceActor, {
        type: REQUESTS.getDescription,
      })) as GetDescriptionResponse;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!response) throw lastError;
  const description: DeviceDescription | undefined = response.value;
  if (description?.apptype !== "firefox") {
    throw new FirefoxCompatibilityError(
      `RDP endpoint is ${description?.apptype ?? "an unknown application"}, not Firefox`
    );
  }
  if (typeof description.version !== "string") {
    throw new FirefoxCompatibilityError("Firefox RDP device actor did not report a version");
  }
  const major = parseFirefoxMajor(description.version);
  if (major === undefined) {
    throw new FirefoxCompatibilityError(
      `Firefox RDP reported an unrecognized version: ${description.version}`
    );
  }

  return {
    version: description.version,
    major,
    channel: description.channel,
    buildId: description.appbuildid,
  };
}

/** Detect and enforce the Firefox compatibility window on an open RDP client. */
export async function requireCompatibleFirefox(
  client: RdpClient,
  logger?: Logger
): Promise<FirefoxRuntime> {
  const runtime = await detectFirefoxRuntime(client);
  const incompatibility = firefoxCompatibilityError(runtime);
  if (incompatibility) {
    const override = "Set FIREFOX_LLDB_ALLOW_UNSUPPORTED=1 to continue at your own risk.";
    if (!allowUnsupportedFirefox()) {
      throw new FirefoxCompatibilityError(`${incompatibility} ${override}`);
    }
    logger?.warn(`${incompatibility} Continuing because FIREFOX_LLDB_ALLOW_UNSUPPORTED=1.`);
  }
  logger?.debug(
    `[rdp] Firefox ${runtime.version}${runtime.channel ? ` (${runtime.channel})` : ""}`
  );
  return runtime;
}
