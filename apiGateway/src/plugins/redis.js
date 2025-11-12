import fp from "fastify-plugin";
import Redis from "ioredis";

export default fp(async function (fastify) {
  const redis = new Redis(process.env.REDIS_URL);
  fastify.decorate("redis", redis);
});
