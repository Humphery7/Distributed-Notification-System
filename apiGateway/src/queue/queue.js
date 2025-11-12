import amqp from "amqplib";

export async function createQueue({url, exchange='notifications.direct'}={}){

    if (!url) throw new Error("RABBITMQ url required");

    const conn = await amqp.connect(url);
    const channel = await conn.createChannel();
    await channel.assertExchange(exchange, "direct", {durable:true});

    async function publish(routingKey, message, options={}){
        const payload = Buffer.from(JSON.stringify(message));
        return channel.publish(exchange, routingKey, payload, { persistent: true, ...options });
    }

    async function assertQueue(name, options={}){
        await channel.assertQueue(name, {durable: true, ...options});
        return channel.bindQueue(name, exchange, name.replace(/\.(queue|q)$/, ""))
    }

    async function close(){
        try{
            await channel.close();
            await connection.close();
        }catch(_){}
    }

    async function checkConnection() {
        return !channel.connection.stream.destroyed;
      }

    return {
        publish,
        assertQueue,
        close,
        checkConnection,
        _raw: { connection, channel, exchange }
      };
}