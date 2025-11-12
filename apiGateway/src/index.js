import { build } from "./app.js";

const PORT = process.env.PORT || 3000;

const start = async () => {
  const app = await build();

  try {
    await app.listen({ port: Number(PORT), host: "0.0.0.0" });
    app.log.info(`API Gateway listening on ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
