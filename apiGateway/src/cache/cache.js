import Redis from "ioredis";

export default function createRedis({url}= {}){
    if (!url) throw new Error("Redis Url Required");
    const client = new Redis(url);

    client.on("error", (e)=>{
        console.error("Redis error", e.message);
    });

    async function setKey(key, value, ttlSeconds){
        const val = typeof value === 'string'?value: JSON.stringify(value);

        if (ttlSeconds){
            return client.set(key, value, "EX", ttlSeconds);
        }

        return client.set(key,value);
    }

    async function getKey(key) {
        const v = await client.get(key);
        if (!v) return null;
    
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
    
    async function delKey(key) {
        return client.del(key);
      }
    
    return Object.assign(client, { setKey, getKey, delKey });

}