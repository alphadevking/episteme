// tools/abstention.ts
//
// What the agent is told when NOTHING answered the question.
//
// Split out of grounded-response-tool.ts so it can be unit tested: that module
// builds a Pinecone client at import time and throws without credentials, which
// would make the most user-visible text in the product the only text nothing
// could assert against.
//
// This path is reached for a whole CATEGORY of real question, not a rare edge.
// The corpus is a student handbook: it answers conduct, examinations, services,
// facilities and discipline, and answers nothing about fees, registration,
// transcripts or CGPA, because no student-records document has been ingested.
// Those are exactly the questions students ask most, so what this text says is
// what many users will actually read. See KB_UNLABELLED for the measurements.

import type { ReachableSource } from './corpus-manifest';

/**
 * The one destination we can name without inventing anything.
 *
 * The previous abstention told the model to "advise the user to contact the
 * relevant office" and never supplied an office list — so the model produced one
 * from memory, sometimes with a phone number or address that exists nowhere in
 * the corpus. That is the same fabrication the rest of the prompt forbids
 * (never invent course codes; copy names letter-for-letter), except here it was
 * required. This is the institution's own site: it is the origin of the
 * ingested documents and is on the web tier's allowlist, so it is verified in a
 * way no named office currently is.
 */
const VERIFIED_ESCALATION = 'https://uniben.edu';

/**
 * The abstention payload.
 *
 * WHY IT CARRIES A DOCUMENT LIST. On this branch the model is asked to offer the
 * user other angles to try — and previously had to guess them, having been told
 * in the same payload that it has not been shown what the knowledge base
 * contains. Its options routinely pointed at subjects no ingested document
 * covers, so picking one produced a second refusal.
 *
 * `reachable` is the set of documents this caller can actually read, obtained
 * through the same gate as retrieval (see corpus-manifest.ts). Alternatives
 * grounded in it are answerable by construction. An EMPTY list is meaningful
 * rather than a failure: it means the honest response is to offer nothing, and
 * the instruction below says so explicitly instead of leaving a vacuum the model
 * will fill.
 */
export function buildAbstentionAnswer(query: string, reachable: ReachableSource[]): string {
  const lines = [
    `NO_RESULTS: The knowledge base does not contain verified information matching this query ("${query}").`,
    '',
  ];

  if (reachable.length > 0) {
    lines.push(
      'DOCUMENTS THIS USER CAN READ — the complete list; there is nothing else:',
      ...reachable.map((r) => `  - ${r.label}  (${r.source})`),
      '',
      'Offer 2–3 alternative questions drawn ONLY from what these documents plausibly',
      'cover. Do not offer a topic merely because the user asked about it — an option',
      'that no document above could answer sends them into a second refusal, which is',
      'worse than offering nothing. Do not name or quote these documents as if you had',
      'read them: you have been shown their existence, not their contents.',
    );
  } else {
    lines.push(
      'NO DOCUMENTS ARE AVAILABLE TO THIS USER for this kind of question.',
      'Do NOT offer alternative angles — there is nothing to retrieve, so every option',
      'would dead-end. Say plainly that you have no verified information on this.',
    );
  }

  lines.push(
    '',
    `If the user needs to take this further, refer them to ${VERIFIED_ESCALATION} — the`,
    'university\'s own site. Do NOT name a specific office, department, email address or',
    'phone number: none is present in any source you have been given, and inventing one',
    'sends a real person to the wrong place.',
  );

  return lines.join('\n');
}
