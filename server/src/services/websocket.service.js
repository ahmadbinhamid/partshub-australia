// services/websocket.service.js

const { Server } = require("socket.io");
const { logger } = require("../loaders/logging");
const { verifyJwt } = require("../utils/auth/jwt");

let io = null;

function initialize(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // JWT auth handshake
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace("Bearer ", "");

    if (!token) {
      // Allow unauthenticated connections; set socket.user = null
      socket.user = null;
      return next();
    }

    try {
      socket.user = verifyJwt(token);
    } catch {
      socket.user = null;
    }

    return next();
  });

  io.on("connection", (socket) => {
    logger.info({
      message: "WebSocket connected",
      socketId: socket.id,
      userId: socket.user?.sub ?? "anonymous",
    });

    // Join a personal room so the server can target this user
    if (socket.user?.sub) {
      // NOTE (lint fix): Socket#join is typed Promise<void> | void because
      // socket.io supports async adapters (e.g. Redis) — this server uses
      // the default in-memory adapter (no adapter configured), where join()
      // is actually synchronous. `void` documents that this is a known,
      // deliberately-ignored return, not a missed await.
      void socket.join(`user:${socket.user.sub}`);
    }

    socket.on("disconnect", (reason) => {
      logger.info({
        message: "WebSocket disconnected",
        socketId: socket.id,
        reason,
      });
    });
  });

  logger.info({ message: "WebSocket service initialized" });
  return io;
}

module.exports = { initialize };
