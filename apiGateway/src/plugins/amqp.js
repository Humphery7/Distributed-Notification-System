// import fp from "fastify-plugin";
// import amqp from "amqplib";

// export default fp(async function (fastify) {
//   const connection = await amqp.connect(process.env.RABBITMQ_URL);
//   const channel = await connection.createChannel();

//   await channel.assertExchange("notifications.direct", "direct", { durable: true });

//   fastify.decorate("amqp", {
//     publish: async (routingKey, message, options) => {
//       channel.publish(
//         "notifications.direct",
//         routingKey,
//         Buffer.from(JSON.stringify(message)),
//         options
//       );
//     },
//   });
// });



import fp from "fastify-plugin";
import amqp from "amqplib";

export default fp(async function (fastify) {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  const EXCHANGE = "notifications.direct";
  await channel.assertExchange(EXCHANGE, "direct", { durable: true });

  fastify.decorate("amqp", {
    publish: async (routingKey, message, options = {}) => {
      return channel.publish(
        EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          ...options
        }
      );
    },

    assertQueue: async (queueName) => {
      await channel.assertQueue(queueName, { durable: true });
      await channel.bindQueue(queueName, EXCHANGE, queueName);
    },

    close: async () => {
      await channel.close();
      await connection.close();
    }
  });
});
