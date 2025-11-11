import "dotenv/config";
import app, { repository } from "./app.js";
import { bootstrapPersistence, persistenceMode } from "./persistence.js";

const port = Number(process.env.PORT ?? 4030);
bootstrapPersistence("metabridge")
  .then(async (result) => {
    await repository.initialize();
    const server = app.listen(port, () => console.log(`MetaBridge API listening on :${port} (${result.mode}/${persistenceMode()})`));
    const shutdown = async () => { await repository.close(); server.close(() => process.exit(0)); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch((error) => { console.error(error); process.exit(1); });
