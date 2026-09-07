// server.js

const http = require("http");
const app = require("./app");
const config = require("./config");
const { connectMongo } = require("./loaders/mongoose");
const { logger } = require("./loaders/logging");
const webSocketService = require("./services/websocket.service");

// NOTE (lint fix): `void` on the IIFE — its own try/catch already routes
// every failure through process.exit(1), so the promise it returns never
// actually rejects; this documents that the top level deliberately doesn't
// await it (there's nothing to await into — this IS the entry point).
void (async () => {
  try {
    await connectMongo();

    // Create HTTP server
    const server = http.createServer(app);

    // Initialize WebSocket service
    webSocketService.initialize(server);

    server.listen(config.port, () => {
      logger.info({ message: `Server listening on port ${config.port}` });
    });
  } catch (err) {
    logger.error({ message: "Fatal startup error", err });
    process.exit(1);
  }
})();
