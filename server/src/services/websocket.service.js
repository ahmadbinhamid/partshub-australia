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

// Targets the per-user rooms `initialize()` already joins each connection
// to — no new room scheme needed. Best-effort: a caller's notification
// pipeline should never throw just because no socket server is up yet
// (e.g. under test), so this silently no-ops instead.
function emitToUsers(userIds, event, payload) {
  if (!io) return;
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit(event, payload);
  }
}

module.exports = { initialize, emitToUsers };
