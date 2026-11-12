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
  "Should the assistant read the skill `skill.name`, described below, before working on `state.task`?";
/**
 * Many skills are invoked by name or by a trigger phrase ("Trigger this if the user says 'council'"),
 * with a description that says nothing about what they do. Without the trigger clause such a skill
 * scores ~0.5 even when the user names it, because the scorer can't see how it would help.
 * The false criterion keeps a word that only appears in the subject matter ("city council") out.
 */
export const CRITERIA_TRUE =
  "The skill is directly relevant to the task and would change or guide how it is done, or the user asks for the skill by name or says the exact trigger word or phrase from its description";
export const CRITERIA_FALSE =
  "The skill is unrelated, redundant, or would not meaningfully help; a similar-sounding word, or a word that only appears in what the task is about (its code, data or topic), does not invoke a skill";

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
  const baseUrl = opts.baseUrl ?? process.env.SKILL_LIBRARY_TYPESAFE_API_BASE;
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
    return new CliError(
      2,
      `typesafe api unreachable after ${maxRetries} retries: ${msgOf(err)}. ` +
        "Check network access, DNS, proxy settings, and agent sandbox restrictions; " +
        "a connection failure does not establish a service outage. " +
        "Use 'skill-library list' to browse the local catalog without network access.",
    );
  }
  if (err instanceof AuthenticationError) {
    return new CliError(2, "typesafe api returned 401 unauthorized — check SKILL_LIBRARY_TYPESAFE_API_KEY");
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
  const v = Number(process.env.SKILL_LIBRARY_RETRY_BASE_MS);
  return Number.isFinite(v) && v >= 0 && v <= 60_000 ? v : 1_000;
}
