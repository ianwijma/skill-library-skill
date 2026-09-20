import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  noul,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type NoulQuestion,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { CliError, msgOf } from "./cli.ts";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const MODEL = "jev-latest";
export const QUESTION_TEMPLATE =
  "Would reading the skill `skill.name`, described below, improve how the assistant handles `state.task`?";
export const CRITERIA_TRUE =
  "The skill is directly relevant to the task and would change or guide how it is done";
export const CRITERIA_FALSE =
  "The skill is unrelated, redundant, or would not meaningfully help";

const MAX_RETRIES = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 30_000;

export interface SkillInput {
  id: string;
  name: string;
  description: string;
}

export function buildQuestion(skill: { name: string; description: string }): NoulQuestion {
  return noul(
    {
      skill: { name: skill.name, description: skill.description },
      question: QUESTION_TEMPLATE,
    },
    { true: CRITERIA_TRUE, false: CRITERIA_FALSE },
  );
}

export function buildRequest(
  task: string,
  skills: SkillInput[],
): SystemOneRequest<Record<string, NoulQuestion>> {
  const questions: Record<string, NoulQuestion> = {};
  for (const skill of skills) questions[skill.id] = buildQuestion(skill);
  return { state: { task }, model: MODEL, questions };
}

export interface CallOptions {
  baseUrl?: string;
  retryBaseMs?: number;
  maxRetries?: number;
}

export async function callSystemOne(
  request: SystemOneRequest<Record<string, NoulQuestion>>,
  apiKey: string,
  opts: CallOptions = {},
): Promise<SystemOneResult<Record<string, NoulQuestion>>> {
  const baseUrl = opts.baseUrl ?? process.env.TYPESAFE_API_BASE;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const client = new TypeSafeClient({
    apiKey,
    ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    timeout: ATTEMPT_TIMEOUT_MS,
    retry: {
      maxRetries,
      backoffInitialMs: opts.retryBaseMs ?? retryBaseMsFromEnv(),
      maxRetryAfterMs: MAX_RETRY_AFTER_MS,
    },
  });
  try {
    return await client.systemOne<Record<string, NoulQuestion>>(request);
  } catch (err) {
    throw toCliError(err, maxRetries);
  }
}

function toCliError(err: unknown, maxRetries: number): CliError {
  if (err instanceof APITimeoutError || err instanceof APIConnectionError) {
    return new CliError(2, `typesafe api unreachable after ${maxRetries} retries: ${msgOf(err)}`);
  }
  if (err instanceof AuthenticationError) {
    return new CliError(2, "typesafe api returned 401 unauthorized — check TYPESAFE_API_KEY");
  }
  if (err instanceof UnprocessableEntityError) {
    return new CliError(2, `typesafe api 422 (bad question construction): ${bodyOf(err.body)}`);
  }
  if (err instanceof RateLimitError) {
    return new CliError(2, `typesafe api ${err.status} after ${maxRetries} retries — try again shortly`);
  }
  if (err instanceof APIError) {
    return new CliError(2, `typesafe api ${err.status}: ${bodyOf(err.body)}`);
  }
  return new CliError(2, `typesafe api request failed: ${msgOf(err)}`);
}

function bodyOf(body: unknown): string {
  const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 500 ? `${oneLine.slice(0, 500)}…` : oneLine;
}

function retryBaseMsFromEnv(): number {
  const v = Number(process.env.SLI_RETRY_BASE_MS);
  return Number.isFinite(v) && v >= 0 && v <= 60_000 ? v : 1_000;
}
