"use strict";

// Dormant Foundation-B candidate: the single source of truth for the
// REPOS -> compiled repoId mapping (BUILD-PLAN Phase 1f, Step 4d — closes the
// "must match whatever the rest of the box uses once repoIds are referenced
// live" seam). A repoId is a compiled identifier (§6: "never paths"), derived
// deterministically from the repo's `owner/name`. Every producer AND consumer of
// a maintenance repoId must import THIS function so the value can never drift.
//
// repoId = "repo_" + first 32 hex of sha256(owner/name). 32 hex satisfies the
// contract's REPO_RE (/^repo_[0-9a-f]{16,64}$/) with ample collision margin.
//
// DORMANT: imported only by the activation entry (maintenance-boot-entry.js).

const crypto = require("node:crypto");

const REPO_ID_RE = /^repo_[0-9a-f]{16,64}$/;

// repoIdFor("owner/name") -> "repo_<32 hex>"
function repoIdFor(ownerName) {
  if (typeof ownerName !== "string" || ownerName.trim().length === 0) {
    throw new Error("repoIdFor requires a non-empty owner/name");
  }
  return "repo_" + crypto.createHash("sha256").update(ownerName.trim()).digest("hex").slice(0, 32);
}

// repoIdsFrom("a/b, c/d") -> ["repo_...","repo_..."] (blanks ignored, order kept)
function repoIdsFrom(reposEnv) {
  return String(reposEnv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(repoIdFor);
}

module.exports = { repoIdFor, repoIdsFrom, REPO_ID_RE };
