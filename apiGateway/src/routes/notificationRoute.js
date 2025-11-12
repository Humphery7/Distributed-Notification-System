import fp from "fastify-plugin";
import { notificationPayloadSchema } from "../schemas/notification.schema.js";
import { createResponse } from "../utils/response.js";

export default fp(async function (fastify) {
  const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);

  fastify.post("/notifications/", {
    schema: { body: notificationPayloadSchema }
  }, async (req, reply) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return reply.code(401).send(createResponse({
        success: false,
        message: "unauthorized",
        error: "invalid api key"
      }));
    }

    const payload = req.body;
    const redis = fastify.redis;
    const rabbit = fastify.amqp;


    const idempotencyKey = `idemp:${payload.request_id}`;
    const existing = await redis.get(idempotencyKey);
    if (existing) {
      return reply.code(200).send(createResponse({
        success: true,
        data: existing,
        message: "duplicate_request",
        meta: {
          total: 1,
          limit: 1,
          page: 1,
          total_pages: 1,
          has_next: false,
          has_previous: false
        }
      }));
    }

    const message = {
      ...payload,
      created_at: new Date().toISOString()
    };

    await redis.set(idempotencyKey, JSON.stringify({ status: "pending" }), IDEMPOTENCY_TTL_SECONDS);

    try {
      await rabbit.publish(payload.notification_type, message, { headers: { priority: payload.priority || 0 } });
    } catch (err) {
      await redis.set(idempotencyKey, JSON.stringify({ status: "failed", error: err.message }), IDEMPOTENCY_TTL_SECONDS);
      return reply.code(500).send(createResponse({
        success: false,
        message: "publish_error",
        error: err.message
      }));
    }

    return reply.code(202).send(createResponse({
      success: true,
      data: { request_id: payload.request_id },
      message: "accepted"
    }));
  });
});
