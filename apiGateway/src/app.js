import Fastify from "fastify";
import redisPlugin from "./plugins/redis.js";
import amqpPlugin from "./plugins/amqp.js";
import userRoutes from "./routes/users.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import statusRoutes from "./routes/status.routes.js";



export function build() {
  const fastify = Fastify({ logger: true });


  fastify.register(redisPlugin);
  fastify.register(amqpPlugin);


  fastify.register(userRoutes, { prefix: "/api/v1" });
  fastify.register(notificationRoutes, { prefix: "/api/v1" });
  fastify.register(statusRoutes, { prefix: "/api/v1" });

  
  fastify.get("/health", async () => ({ status: "ok" }));

  return fastify;
}
