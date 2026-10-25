// tsc only emits .js from .ts; copy the UI's static files next to the compiled server.
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
cpSync(path.join(root, "src/ui/static"), path.join(root, "dist/ui/static"), { recursive: true });
