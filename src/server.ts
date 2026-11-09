import "dotenv/config";
import app from "./app.js";
const port = Number(process.env.PORT ?? 4030);
app.listen(port, () => console.log(`MetaBridge listening on :${port}`));
