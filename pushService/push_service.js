
import amqp from "amqplib";
import Redis from "ioredis";
import Fastify from "fastify";
import CircuitBreaker from "opossum";
import pino from "pino";
import admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });


const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SERVICE_PORT = process.env.SERVICE_PORT || 4002;
const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5);


const EXCHANGE = "notifications.direct";
const PUSH_QUEUE = "push.queue";
const FAILED_QUEUE = "failed.queue";


const redis = new Redis(REDIS_URL);


if (!process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
  logger.warn("Firebase env vars missing - FCM will not be available until configured.");
} else {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}


async function raw_send_push({ token, payload }) {
  if (!admin.apps.length) throw new Error("firebase_not_initialized");
  const response = await admin.messaging().sendToDevice(token, payload);
  return response;
}

const breakerOptions = { timeout: 10_000, errorThresholdPercentage: 60, resetTimeout: 30_000 };
const sendPushBreaker = new CircuitBreaker(raw_send_push, breakerOptions);


function build_fcm_payload(metadata, variables) {

  const notif = {
    notification: {
      title: metadata?.title || variables?.title || "Notification",
      body: metadata?.body || variables?.body || (variables?.name ? `Hi ${variables.name}` : "You have a notification"),
      imageUrl: metadata?.image_url,
    },
    data: metadata?.data || {},
    android: { priority: "high" },
    apns: { headers: { "apns-priority": "10" } },
  };
  return notif;
}


async function start() {
  const conn = await amqp.connect(RABBITMQ_URL);
  const channel = await conn.createChannel();

  await channel.assertExchange(EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(PUSH_QUEUE, { durable: true });
  await channel.assertQueue(FAILED_QUEUE, { durable: true });

  await channel.bindQueue(PUSH_QUEUE, EXCHANGE, "push");
  await channel.bindQueue(FAILED_QUEUE, EXCHANGE, "failed");

  logger.info("Push Service connected to RabbitMQ, waiting for messages...");

  channel.consume(PUSH_QUEUE, async (msg) => {
    if (!msg) return;
    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch (err) {
      logger.error("invalid JSON, acking");
      channel.ack(msg);
      return;
    }

    const request_id = payload.request_id || uuidv4();
    const notification_id = payload.notification_id || uuidv4();
    payload.attempts = payload.attempts ? Number(payload.attempts) : 0;

    const idempotency_key = `push:idempotency:${request_id}`;
    const already = await redis.get(idempotency_key);
    if (already) {
      logger.info({ request_id }, "duplicate push request, acking");
      channel.ack(msg);
      return;
    }
    await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "processing" }), "EX", IDEMPOTENCY_TTL_SECONDS);

    try {
      const token = payload.metadata?.push_token;
      if (!token) throw new Error("push_token_missing");


      if (typeof token !== "string" || token.length < 10) throw new Error("invalid_push_token");

      const fcm_payload = build_fcm_payload(payload.metadata, payload.variables);
      const send_result = await sendPushBreaker.fire({ token, payload: fcm_payload });

      const has_error = send_result.results && send_result.results.some(r => r.error);
      if (has_error) {
        const first_error = send_result.results.find(r => r.error).error;
        throw new Error(first_error.message || "fcm_error");
      }

      await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "delivered", sent_at: new Date().toISOString() }), "EX", IDEMPOTENCY_TTL_SECONDS);
      logger.info({ request_id }, "Push delivered");
      channel.ack(msg);
    } catch (err) {
      logger.error({ err, payload }, "Error processing push message");
      payload.attempts += 1;
      if (payload.attempts >= MAX_ATTEMPTS) {
        const failed_payload = { ...payload, error: err.message, failed_at: new Date().toISOString(), notification_id };
        channel.publish(EXCHANGE, "failed", Buffer.from(JSON.stringify(failed_payload)), { persistent: true });
        await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "failed", error: err.message }), "EX", IDEMPOTENCY_TTL_SECONDS);
        channel.ack(msg);
      } else {
        const delay_ms = 2000 * Math.pow(2, payload.attempts - 1);
        setTimeout(() => {
          channel.publish(EXCHANGE, "push", Buffer.from(JSON.stringify(payload)), { persistent: true });
        }, delay_ms);
        channel.ack(msg);
      }
    }
  }, { noAck: false });
}


const app = Fastify({ logger: false });

app.get("/health", async () => ({ status: "ok", service: "push_service", timestamp: new Date().toISOString() }));

app.get("/status/:request_id", async (req, reply) => {
  const request_id = req.params.request_id;
  const key = `push:idempotency:${request_id}`;
  const data = await redis.get(key);
  if (!data) return reply.code(404).send({ success: false, message: "not_found", error: "no status for given request_id", meta: null });
  return { success: true, data: JSON.parse(data), message: "ok", meta: null };
});


(async () => {
  try {
    await start();
    await app.listen({ port: Number(SERVICE_PORT), host: "0.0.0.0" });
    logger.info({ port: SERVICE_PORT }, "Push service listening");
  } catch (err) {
    logger.error({ err }, "Failed starting push service");
    process.exit(1);
  }
})();
