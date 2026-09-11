/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared launch identity and session/adapter timing contracts.

export const LAUNCH_TOKEN_PREF = "firefoxLldb.launchToken";

// Fission can announce a replacement after destroying the old top-level target.
// Wait for that ordering before interpreting destruction as a tab close.
export const DETACH_GRACE_MS = 250;

// Let a replayed breakpoint stop the replacement naturally before requesting
// a real interrupt to publish its modules. This does not decide tab lifetime.
export const RESYNC_GRACE_MS = 250;

// Bound attach-time pause collection when an interrupt loses its target or
// does not produce a pause event. Complete before the outer attach deadline.
export const PRIME_STOP_TIMEOUT_MS = 8000;
// Navigation acceptance and replacement readiness complete independently;
// neither may leave acquisition waiting indefinitely.
export const NAVIGATE_TARGET_TIMEOUT_MS = 10000;
