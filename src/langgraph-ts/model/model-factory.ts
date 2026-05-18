import { readFileSync } from "node:fs";
import path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import type { Phase3ModelAdapter } from "../runtime/contracts.js";
import { createChatOpenAITransport, createProviderModelAdapter, inferProviderName } from "./provider-adapter.js";

type ModelConfigKey = "chat" | "planner";

interface RawModelConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
  temperature?: number;
}

interface RawConfigFile {
  chat?: RawModelConfig;
  planner?: RawModelConfig;
}

export function createPhase3ModelFromConfig(
  key: ModelConfigKey = "chat",
  configPath = resolveDefaultConfigPath()
): Phase3ModelAdapter {
  const config = readModelConfig(configPath, key);
  const llm = new ChatOpenAI({
    apiKey: config.api_key,
    configuration: { baseURL: config.base_url },
    model: config.model,
    temperature: config.temperature ?? 0
  });

  return createProviderModelAdapter(
    {
      provider: inferProviderName(config.base_url, config.model),
      baseUrl: config.base_url,
      model: config.model,
      supportsReasoningContextReplay: /deepseek/i.test(`${config.base_url} ${config.model}`),
      maxInternalTurns: 3
    },
    createChatOpenAITransport(llm)
  );
}

export function tryCreatePhase3ModelFromConfig(
  key: ModelConfigKey = "chat",
  configPath = resolveDefaultConfigPath()
): { model: Phase3ModelAdapter } | { reason: string } {
  try {
    return { model: createPhase3ModelFromConfig(key, configPath) };
  } catch (error) {
    return {
      reason: `无法从配置加载真实模型，跳过真实模型冒烟：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function readModelConfig(configPath: string, key: ModelConfigKey): Required<Pick<RawModelConfig, "base_url" | "api_key" | "model">> &
  Pick<RawModelConfig, "temperature"> {
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as RawConfigFile;
  const section = rawConfig[key];
  if (!section) {
    throw new Error(`配置文件缺少 '${key}' 段`);
  }
  const baseUrl = section.base_url?.trim();
  const apiKey = section.api_key?.trim();
  const model = section.model?.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error(`配置文件 '${key}' 段缺少 base_url / api_key / model`);
  }
  return {
    base_url: baseUrl,
    api_key: apiKey,
    model,
    temperature: section.temperature
  };
}

function resolveDefaultConfigPath(): string {
  return path.resolve(process.cwd(), "..", "..", "config.json");
}
