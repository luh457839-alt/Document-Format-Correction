import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  resolve: {
    alias: [
      { find: "@langchain/core/messages", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/core/messages.js") },
      { find: "@langchain/core/tools", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/core/tools.js") },
      { find: "@langchain/langgraph/prebuilt", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/langgraph/dist/prebuilt/index.js") },
      { find: "@langchain/langgraph-checkpoint-sqlite", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.js") },
      { find: "@langchain/openai", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/openai/dist/index.js") },
      { find: "@langchain/core", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/core/dist/index.js") },
      { find: "@langchain/langgraph", replacement: path.resolve(import.meta.dirname, "node_modules/@langchain/langgraph/dist/index.js") },
      { find: "better-sqlite3", replacement: path.resolve(import.meta.dirname, "node_modules/better-sqlite3/lib/index.js") },
      { find: "jszip", replacement: path.resolve(import.meta.dirname, "node_modules/jszip/lib/index.js") },
      { find: "@xmldom/xmldom", replacement: path.resolve(import.meta.dirname, "node_modules/@xmldom/xmldom/lib/index.js") },
      { find: "zod", replacement: path.resolve(import.meta.dirname, "node_modules/zod/index.js") }
    ]
  },
  test: {
    include: ["langgraph-ts/tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
