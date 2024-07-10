import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  MAIN_SERVER_PORT: z.preprocess(
    (val) => parseInt(val as string, 10),
    z.number()
  ),
  DISCOVERY_SERVER_PORT: z.preprocess(
    (val) => parseInt(val as string, 10),
    z.number()
  ),
  IMAGE_SERVER_PORT: z.preprocess(
    (val) => parseInt(val as string, 10),
    z.number()
  ),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

const config = parsedEnv.data;

export default config;
