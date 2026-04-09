import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { healthRouter } from "./routes/health";
import { authMiddleware } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/api/v1/health", healthRouter);
app.use("/api/v1", authMiddleware, chatRouter);

app.listen(PORT, () => {
  console.log(`Juno Intelligence API running on port ${PORT}`);
});

export default app;
