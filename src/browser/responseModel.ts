import type { BrowserResponseModelEvidence } from "../sessionStore.js";
import type { BrowserAutomationConfig, BrowserLogger, ChromeClient } from "./types.js";
import { GPT_MODEL_CAPABILITIES, resolveGptModelAlias } from "../oracle/modelCapabilities.js";
import { readAssistantSnapshot } from "./actions/assistantResponse.js";
import { BrowserAutomationError } from "../oracle/errors.js";

export function expectedResponseModel(config: BrowserAutomationConfig): string | undefined {
  const model = resolveGptModelAlias(config.expectedModel ?? config.desiredModel ?? undefined);
  if (!model || (config.modelStrategy && config.modelStrategy !== "select")) return undefined;
  return config.thinkingTime === "pro" || model.pro
    ? GPT_MODEL_CAPABILITIES[model.model].browser.proAlias
    : model.model;
}

export function classifyResponseModel(
  expectedModel: string,
  snapshot: {
    messageId?: string | null;
    modelSlug?: string | null;
    text?: string;
    conversationId?: string | null;
  } | null,
  answerText: string,
  conversationId?: string,
  expectedMessageId?: string | null,
): BrowserResponseModelEvidence {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  const evidence: BrowserResponseModelEvidence = {
    expectedModel,
    messageId: snapshot?.messageId ?? null,
    conversationId: snapshot?.conversationId ?? null,
    modelSlug: snapshot?.modelSlug ?? null,
    status: "unavailable",
    source: "assistant-message-dom",
    capturedAt: new Date().toISOString(),
  };
  // Bind the proof to the returned answer in the requested conversation, never a picker or another turn.
  if (
    !conversationId ||
    snapshot?.conversationId !== conversationId ||
    !expectedMessageId ||
    snapshot?.messageId !== expectedMessageId ||
    !snapshot?.messageId ||
    !snapshot.modelSlug ||
    !answerText.trim() ||
    normalize(snapshot.text ?? "") !== normalize(answerText)
  ) {
    return { ...evidence, reason: "missing-message-identity-or-answer-mismatch" };
  }
  const expected = resolveGptModelAlias(expectedModel);
  const actual = resolveGptModelAlias(snapshot.modelSlug);
  // The moving UI label Latest is not an actual response model ID.
  const spec = expected && GPT_MODEL_CAPABILITIES[expected.model];
  const declaredIds: readonly string[] =
    spec && expected ? [expected.model, ...spec.aliases, spec.browser.proAlias] : [];
  const matches =
    expected &&
    actual &&
    declaredIds.includes(snapshot.modelSlug) &&
    expected.model === actual.model &&
    (!expected.pro || actual.pro);
  return { ...evidence, status: matches ? "verified" : "mismatch" };
}

export async function verifyResponseModel(
  Runtime: ChromeClient["Runtime"],
  config: BrowserAutomationConfig,
  answerText: string,
  logger: BrowserLogger,
  minTurnIndex?: number,
  conversationId?: string,
  expectedMessageId?: string | null,
): Promise<BrowserResponseModelEvidence | undefined> {
  const expected = expectedResponseModel(config);
  if (!expected) return undefined;
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, conversationId).catch(
    () => null,
  );
  const evidence = classifyResponseModel(
    expected,
    snapshot,
    answerText,
    conversationId,
    expectedMessageId,
  );
  logger(
    `[browser] Response model: expected=${expected}; actual=${evidence.modelSlug ?? "unknown"}; message=${evidence.messageId ?? "unknown"}; status=${evidence.status}`,
  );
  if (evidence.status === "mismatch") {
    throw new BrowserAutomationError(
      `Response model mismatch: requested ${expected}, message ${evidence.messageId} reports ${evidence.modelSlug}. The prompt was already submitted; inspect this session instead of resending.`,
      {
        stage: "response-model-verification",
        details: { responseModel: evidence, promptSubmitted: true },
      },
    );
  }
  return evidence;
}
