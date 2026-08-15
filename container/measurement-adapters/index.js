// container/measurement-adapters/index.js
// The one registry of providers this box can actually read.
//
// It lives here rather than inline in gate.js because TWO places have to agree
// on it: the hourly tick, which looks up an adapter per connection, and the
// POST /measurement/connections route, which must refuse a provider nothing can
// ever sync. Two copies of that list would drift, and the failure would be a
// connection that saves fine and then never produces a fact -- inert, and
// looking exactly like a healthy quiet account.
"use strict";

const ADAPTERS = Object.freeze({
  meta_ads: require("./meta-ads.js"),
});

// Sorted so a refusal message names them in a stable order rather than in
// whatever order the object happens to enumerate.
const PROVIDERS = Object.freeze(Object.keys(ADAPTERS).sort());

module.exports = { ADAPTERS, PROVIDERS };
