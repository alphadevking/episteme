/**
 * Episteme scorers — run after every agent turn to evaluate response quality.
 *
 * groundedToolUsageScorer: checks that groundedResponseTool was called (P1)
 * faithfulnessScorer:      entity-level check — flags facts in the agent
 *                          response not present in the retrieved tool output (P2-A)
 *
 * Both run at ratio sampling so cost stays bounded.
 */
import { createScorer } from '@mastra/core/evals';
import { getAssistantMessageFromRunOutput } from '@mastra/evals/scorers/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

type RunMessage = Record<string, unknown>;

function wasToolCalled(run: Record<string, unknown>, toolName: string): boolean {
  const output = run?.output;
  if (!output) return false;
  const messages: RunMessage[] = Array.isArray(output) ? output : ((output as Record<string, unknown>)?.messages as RunMessage[] ?? []);
  return messages.some((msg) => {
    const calls: RunMessage[] = (msg?.toolInvocations ?? msg?.toolCalls ?? []) as RunMessage[];
    return calls.some((c) => c?.toolName === toolName || (c?.function as Record<string, unknown>)?.name === toolName);
  });
}

// A clarification turn is one where the agent asked an options-style question
// instead of calling groundedResponseTool. Detected by the presence of lettered
// options in the response — "(A)" … "(B)" — which the instructions mandate.
function isClarificationTurn(response: string, toolCalled: boolean): boolean {
  if (toolCalled) return false;
  return /\(A\)/.test(response) && /\(B\)/.test(response);
}

// ── P1 scorer: tool was called (or a valid clarification was issued) ──────────
export const groundedToolUsageScorer = createScorer({
  id: 'episteme-grounded-tool-usage',
  name: 'Episteme Grounded Tool Usage',
  description:
    'Checks that groundedResponseTool was called for Uniben questions. ' +
    'Passes when the tool was called OR when the agent issued a valid option-style clarification ' +
    '(asking "(A)…(B)…" before retrieval). Fails only when the agent answered without grounding.',
})
  .preprocess(({ run }) => {
    const toolCalled = wasToolCalled(run as Record<string, any>, 'groundedResponseTool');
    const response   = getAssistantMessageFromRunOutput((run as Record<string, any>)?.output) ?? '';
    const clarifying = isClarificationTurn(response, toolCalled);
    return { toolCalled, clarifying, response };
  })
  .generateScore(({ results }) => {
    const { toolCalled, clarifying } = results.preprocessStepResult;
    return toolCalled || clarifying ? 1 : 0;
  })
  .generateReason(({ results }) => {
    const { toolCalled, clarifying } = results.preprocessStepResult;
    if (toolCalled)   return 'groundedResponseTool was called — grounded response.';
    if (clarifying)   return 'Agent issued a valid option-style clarification — tool call deferred correctly.';
    return 'groundedResponseTool was not called and no valid clarification was issued.';
  });

/**
 * Extracts the `answer` field from the most recent groundedResponseTool result
 * in the run output. Returns an empty string if not found.
 */
function extractToolAnswer(run: Record<string, any>): string {
  const output = run?.output;
  if (!output) return '';

  // Mastra run output may be an array of messages or an object with toolResults.
  const messages: any[] = Array.isArray(output) ? output : (output?.messages ?? []);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // Look for tool result messages from groundedResponseTool
    if (msg?.role === 'tool' || msg?.type === 'tool-result') {
      const parts: any[] = msg?.content ?? msg?.parts ?? [];
      for (const part of parts) {
        const result = part?.result ?? part;
        if (typeof result?.answer === 'string') return result.answer;
      }
    }
    // Also check toolResults on assistant messages (Mastra v0.x shape)
    const toolResults: any[] = msg?.toolResults ?? msg?.toolInvocations ?? [];
    for (const tr of toolResults) {
      if (tr?.toolName === 'groundedResponseTool') {
        const ans = tr?.result?.answer ?? tr?.output?.answer;
        if (typeof ans === 'string') return ans;
      }
    }
  }

  return '';
}

/**
 * Named-entity extraction — pure regex, no LLM.
 * Targets the entity classes most likely to be hallucinated in academic contexts:
 *   - Dates and years
 *   - Numeric values: GPA, percentages, deadlines, policy numbers
 *   - Multi-word proper nouns (department names, policy titles, person names)
 */
function extractEntities(text: string): string[] {
  const entities: Set<string> = new Set();

  // Years and structured dates
  const dates = text.match(
    /\b\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/gi
  ) ?? [];

  // Numeric academic values: GPA, CGPA, percentages, course codes
  const numbers = text.match(/\b\d+\.\d+\b|\b\d+\s*%\b|\b[A-Z]{2,}\s*\d{3,}\b/g) ?? [];

  // Multi-word capitalized proper nouns (skip common sentence-starters)
  const properNouns = text.match(/\b(?:[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){1,})\b/g) ?? [];

  for (const e of [...dates, ...numbers, ...properNouns]) {
    entities.add(e.trim());
  }

  return [...entities];
}

// ── P2-A scorer: faithfulness ─────────────────────────────────────────────────
export const faithfulnessScorer = createScorer({
  id: 'episteme-faithfulness',
  name: 'Episteme Faithfulness',
  description:
    'Entity-level faithfulness check. Extracts named entities (dates, numbers, proper nouns) ' +
    'from the agent response and verifies each appears in the groundedResponseTool output. ' +
    'Score = 1 − (hallucinated_entities / total_entities). ' +
    'A score < 0.8 means the agent added facts not present in the retrieved sources.',
})
  .preprocess(({ run }) => {
    const toolAnswer     = extractToolAnswer(run as Record<string, any>);
    const agentResponse  = getAssistantMessageFromRunOutput((run as Record<string, any>)?.output) ?? '';

    if (!toolAnswer || !agentResponse) {
      // Tool was not called or response is empty — handled by groundedToolUsageScorer
      return { hallucinated: [], total: 0, toolCalled: false };
    }

    const entities    = extractEntities(agentResponse);
    const hallucinated = entities.filter(
      (e) => !toolAnswer.toLowerCase().includes(e.toLowerCase())
    );

    return {
      hallucinated,
      total:      entities.length,
      toolCalled: true,
    };
  })
  .generateScore(({ results }) => {
    const { hallucinated, total, toolCalled } = results.preprocessStepResult;
    if (!toolCalled) return 1; // groundedToolUsageScorer handles the tool-missing case
    if (total === 0)  return 1; // no named entities to check — pass
    return Math.max(0, 1 - hallucinated.length / total);
  })
  .generateReason(({ results, score }) => {
    const { hallucinated, total, toolCalled } = results.preprocessStepResult;
    if (!toolCalled) return 'groundedResponseTool was not called — see groundedToolUsageScorer.';
    if (total === 0)  return 'No named entities in response — faithfulness check not applicable.';
    return (
      `Faithfulness: ${total - hallucinated.length}/${total} entities grounded in sources. ` +
      `Score=${score.toFixed(2)}.` +
      (hallucinated.length > 0 ? ` Ungrounded: [${hallucinated.join(', ')}]` : '')
    );
  });

export const scorers = {
  groundedToolUsageScorer,
  faithfulnessScorer,
};
