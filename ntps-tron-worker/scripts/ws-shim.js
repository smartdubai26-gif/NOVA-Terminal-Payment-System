"use strict";
if (typeof globalThis.WebSocket === "undefined") {
  try {
    globalThis.WebSocket = require("ws");
  } catch {
    try {
      const path = require("node:path");
      const workerDir = process.env.WORKER_DIR || path.resolve(__dirname, "..");
      globalThis.WebSocket = require(path.join(workerDir, "node_modules", "ws"));
    } catch {
      // Optional WebSocket polyfill for Node < 22
    }
  }
}
