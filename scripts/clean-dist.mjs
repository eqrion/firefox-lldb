/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rm } from "node:fs/promises";

// `tsc` does not remove outputs whose sources were deleted. Always rebuild the
// package from an empty, repository-local output directory so retired entry
// points cannot survive in a published tarball.
await rm("dist", { recursive: true, force: true });
