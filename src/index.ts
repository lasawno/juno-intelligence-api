import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { healthRouter } from "./routes/health";
import { modelsRouter } from "./routes/models";
import { visionRouter } from "./routes/vision";
import { authMiddleware } from "./middleware/auth";
import { connectToCore, startHeartbeat } from "./lib/juno-core-client";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.use("/api/v1/health", healthRouter);
app.use("/api/v1", authMiddleware, chatRouter);
app.use("/api/v1", authMiddleware, modelsRouter);
app.use("/api/v1", authMiddleware, visionRouter);

app.listen(PORT, () => {
    console.log(`Juno Intelligence API running on port ${PORT}`);

    // Connect to Juno Intelligence Core (offload compute engines)
    connectToCore().then(() => {
      startHeartbeat();
    }).catch((err) => {
      console.warn("[Startup] Intelligence Core connection deferred:", err?.message);
    });
  });

export default app;
