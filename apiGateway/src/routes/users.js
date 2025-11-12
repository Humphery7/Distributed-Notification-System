import fp from "fastify-plugin";
import { userPayloadSchema } from "../schemas/user.schema.js";
import { createResponse } from "../utils/response.js";

export default fp(async function (fastify) {
  fastify.post("/users/", {
    schema: { body: userPayloadSchema }
  }, async (req, reply) => {

    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return reply.code(401).send(createResponse({
        success: false,
        message: "unauthorized",
        error: "invalid api key"
      }));
    }

    try {
      await fastify.amqp.publish("user.created", req.body, { headers: {} });

      return reply.code(202).send(createResponse({
        success: true,
        message: "user_creation_queued"
      }));
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send(createResponse({
        success: false,
        message: "queue_error",
        error: err.message
      }));
    }
  });
});
