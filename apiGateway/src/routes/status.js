import fp from "fastify-plugin";
import { createResponse } from "../utils/response.js";

export default fp(async function (fastify) {
  const STATUS_TTL_SECONDS = Number(process.env.STATUS_TTL_SECONDS || 86400);

  fastify.post("/:notification_type/status/", async (req, reply) => {
    const { notification_type } = req.params;
    const { notification_id, status, timestamp, error } = req.body;
    const redis = fastify.redis;

    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return reply.code(401).send(createResponse({
        success: false,
        message: "unauthorized",
        error: "invalid api key"
      }));
    }

    if (!["email", "push"].includes(notification_type)) {
      return reply.code(400).send(createResponse({
        success: false,
        message: "invalid_notification_type",
        error: `Allowed: email, push`
      }));
    }

    if (!notification_id || !status || !["delivered", "pending", "failed"].includes(status)) {
      return reply.code(400).send(createResponse({
        success: false,
        message: "validation_error",
        error: "notification_id and valid status are required"
      }));
    }

    const statusData = {
      notification_id,
      status,
      timestamp: timestamp || new Date().toISOString(),
      error: error || null
    };

    try {
      await redis.set(`status:${notification_id}`, JSON.stringify(statusData), "EX", STATUS_TTL_SECONDS);
      return reply.code(200).send(createResponse({
        success: true,
        data: statusData,
        message: "status_updated"
      }));
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send(createResponse({
        success: false,
        message: "redis_error",
        error: err.message
      }));
    }
  });
});
