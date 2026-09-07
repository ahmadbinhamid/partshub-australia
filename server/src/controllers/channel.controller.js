// controllers/channel.controller.js

const registry = require("../services/marketplace/registry");
const channelService = require("../services/marketplace/channel.service");
const { success, notFound, systemfailure } = require("../utils/http/response");

exports.listChannels = async (req, res) => {
  try {
    const channels = await channelService.listChannelsForTenant(req.tenantId);
    return success(res, channels);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getLogs = async (req, res) => {
  try {
    const { platform } = req.params;
    if (!registry.has(platform)) return notFound(res, `Unknown platform: ${platform}`);

    const { page, limit } = req.pagination;
    const result = await channelService.getChannelLogs(req.tenantId, platform, { page, limit });
    return success(res, result);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.retryLog = async (req, res) => {
  try {
    const { platform, logId } = req.params;
    if (!registry.has(platform)) return notFound(res, `Unknown platform: ${platform}`);

    const result = await channelService.retryChannelLog(req.tenantId, platform, logId);
    if (!result) return notFound(res, "Log entry not found");
    return success(res, result, "Retry enqueued");
  } catch (err) {
    return systemfailure(res, err);
  }
};
