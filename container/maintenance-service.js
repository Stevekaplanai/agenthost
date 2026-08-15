"use strict";

// Dormant Foundation-A composition root. It deliberately exposes a state core,
// not a listener or a dispatcher. Activation requires the later reviewed native
// transport and root process topology.

const { createMaintenanceStore } = require("./maintenance-store.js");

function createDormantMaintenanceService(options = {}) {
  const store = createMaintenanceStore(options);
  return Object.freeze({
    open: () => store.open(),
    health: () => store.health(),
    snapshot: () => store.snapshot(),
    advanceMigration: (state) => store.advanceMigration(state),
    lookupIdempotency: (request) => store.lookupIdempotency(request),
    commitIdempotency: (record) => store.commitIdempotency(record),
  });
}

module.exports = { createDormantMaintenanceService };
