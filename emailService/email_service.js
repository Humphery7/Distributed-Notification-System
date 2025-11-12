/**
 * email_service.js
 *
 * Node.js Email Service:
 * - Connects to RabbitMQ and listens to `email.queue`
 * - Processes messages with idempotency, retries, circuit breaker
 * - Publishes failed messages to `failed.queue`
 * - Exposes /health and /status/:notification_id endpoints using Fastify
 *
 * Message format (from API gateway):
 * {
 *   notification_type: "email",
 *   user_id: "<uuid>",
 *   template_code: "welcome_v1",
 *   variables: { name: "Ada", link: "https://..." },
 *   request_id: "<unique-id>",
 *   priority: 1,
 *   metadata: { email: "user@example.com" },
 *   attempts: 0    // added by service when retrying
 * }
 */

import amqp from "amqplib";
import Redis from "ioredis";
import nodemailer from "nodemailer";
import Fastify from "fastify";
import CircuitBreaker from "opossum";
import pino from "pino";
import { v4 as uuidv4 } from "uuid";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/* Config */
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const EMAIL_FROM = process.env.EMAIL_FROM || "no-reply@example.com";
const SERVICE_PORT = process.env.SERVICE_PORT || 4001;
const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5);

/* RabbitMQ queue names */
const EXCHANGE = "notifications.direct";
const EMAIL_QUEUE = "email.queue";
const FAILED_QUEUE = "failed.queue";

/* Initialize clients */
const redis = new Redis(REDIS_URL);

/* Nodemailer transporter (SMTP) */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* If you want to use SendGrid via nodemailer, set up a sendgrid transport here (optional) */

/* Circuit breaker wrapped send function */
async function raw_send_email({ to, subject, html, text }) {
  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });
  return info;
}
const breakerOptions = {
  timeout: 10_000, // 10s
  errorThresholdPercentage: 60,
  resetTimeout: 30_000, // after 30s try again
};
const sendEmailBreaker = new CircuitBreaker(raw_send_email, breakerOptions);

/* Helper: render template (very simple) */
function render_template(template_code, variables) {
  // In real system fetch from Template Service synchronously
  // Minimal example: template_code -> string with {{name}} replacement
  const templates = {
    "welcome_v1": `<p>Hi {{name}}, welcome! Click <a href="{{link}}">here</a>.</p>`,
    "otp_v1": `<p>Your OTP is: {{otp}}</p>`,
  };
  const tpl = templates[template_code] || `{{name}} - notification`;
  return tpl.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => variables?.[key.trim()] ?? "");
}

/* Connect to RabbitMQ and start consuming */
async function start() {
  const conn = await amqp.connect(RABBITMQ_URL);
  const channel = await conn.createChannel();

  await channel.assertExchange(EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(EMAIL_QUEUE, { durable: true });
  await channel.assertQueue(FAILED_QUEUE, { durable: true });

  await channel.bindQueue(EMAIL_QUEUE, EXCHANGE, "email");
  await channel.bindQueue(FAILED_QUEUE, EXCHANGE, "failed");

  logger.info("Email Service connected to RabbitMQ, waiting for messages...");

  channel.consume(EMAIL_QUEUE, async (msg) => {
    if (!msg) return;
    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch (err) {
      logger.error({ err }, "Invalid JSON message, acking to drop");
      channel.ack(msg);
      return;
    }

    const request_id = payload.request_id || uuidv4();
    const notification_id = payload.notification_id || uuidv4(); // internal id
    payload.attempts = payload.attempts ? Number(payload.attempts) : 0;

    const idempotency_key = `email:idempotency:${request_id}`;
    const already = await redis.get(idempotency_key);
    if (already) {
      logger.info({ request_id }, "Duplicate request id - acking message (idempotent)");
      channel.ack(msg);
      return;
    }

    // mark as processing to prevent duplicates
    await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "processing" }), "EX", IDEMPOTENCY_TTL_SECONDS);

    try {
      // Basic delivery check: ensure metadata.email exists
      const to = payload.metadata?.email;
      if (!to) throw new Error("recipient email missing in metadata.email");

      // Render template (in production: call Template Service)
      const html = render_template(payload.template_code, payload.variables || {});
      const text = html.replace(/<[^>]*>/g, "");

      // Use circuit breaker to call external SMTP
      const send_result = await sendEmailBreaker.fire({ to, subject: payload.metadata?.subject || "Notification", html, text });

      // Mark delivered in redis
      await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "delivered", sent_at: new Date().toISOString() }), "EX", IDEMPOTENCY_TTL_SECONDS);

      logger.info({ request_id, to, result: send_result }, "Email sent");
      // Acknowledge message
      channel.ack(msg);
    } catch (err) {
      logger.error({ err, payload }, "Error processing email message");
      payload.attempts += 1;
      if (payload.attempts >= MAX_ATTEMPTS) {
        // publish to failed queue with error info
        const failed_payload = { ...payload, error: err.message, failed_at: new Date().toISOString(), notification_id };
        channel.publish(EXCHANGE, "failed", Buffer.from(JSON.stringify(failed_payload)), { persistent: true });
        // mark failed in redis
        await redis.set(idempotency_key, JSON.stringify({ notification_id, status: "failed", error: err.message }), "EX", IDEMPOTENCY_TTL_SECONDS);
        channel.ack(msg);
      } else {
        // exponential backoff then requeue (in-service)
        const delay_ms = 2000 * Math.pow(2, payload.attempts - 1);
        logger.info({ attempts: payload.attempts, delay_ms }, "Retrying message after backoff");
        setTimeout(() => {
          // re-publish to email routing key
          channel.publish(EXCHANGE, "email", Buffer.from(JSON.stringify(payload)), { persistent: true });
        }, delay_ms);
        channel.ack(msg);
      }
    }
  }, { noAck: false });
}

/* Fastify endpoints: /health and simple /status/:notification_id which reads redis */
const app = Fastify({ logger: false });

app.get("/health", async () => {
  return { status: "ok", service: "email_service", timestamp: new Date().toISOString() };
});

app.get("/status/:request_id", async (req, reply) => {
  const request_id = req.params.request_id;
  const key = `email:idempotency:${request_id}`;
  const data = await redis.get(key);
  if (!data) {
    return reply.code(404).send({ success: false, message: "not_found", error: "no status for given request_id", meta: null });
  }
  return { success: true, data: JSON.parse(data), message: "ok", meta: null };
});

/* Start everything */
(async () => {
  try {
    await start();
    await app.listen({ port: Number(SERVICE_PORT), host: "0.0.0.0" });
    logger.info({ port: SERVICE_PORT }, "Email service listening");
  } catch (err) {
    logger.error({ err }, "Failed starting email service");
    process.exit(1);
  }
})();
