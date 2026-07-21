import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../config";

const sql = postgres(env.databaseUrl, { max: 10 });

export const db = drizzle(sql, { schema });
export { schema, sql };
