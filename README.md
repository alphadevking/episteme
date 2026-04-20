# Episteme

**Episteme** is an AI-powered institutional assistant built for the Faculty of Computing, University of Benin (Uniben). It answers student, staff, and prospective applicant questions about university policies, programmes, and procedures using only verified institutional knowledge — no hallucinations, no general web answers.

---

## What it does

- **Grounded Q&A** — Every response is retrieved from an institution-specific knowledge base and cited with its source and freshness date. The agent abstains rather than guessing when confidence is low.
- **Role-aware retrieval** — Queries are personalised at retrieval time using the user's role (prospective, student, staff, HOD), programme, level, and department to surface the most relevant chunks.
- **Certification verification** — Students and staff can submit claims (transcripts, degree certificates, enrollment letters, result verifications). A human-in-the-loop workflow routes each claim through admin assignment and HOD approval.
- **Multi-role access** — Separate dashboards for students, staff, Heads of Department, admins, and superadmins. Role assignment is handled via a secure staff invitation flow.
- **Conversation memory** — The assistant maintains per-user session context across turns, enabling coherent multi-turn dialogue.
- **Observability & evals** — Every agent turn is traced. Two automated scorers — grounded tool usage and faithfulness — run inline to catch regressions.

---

## Repository layout

```
Episteme/
├── episteme-chat/     # Next.js front-end — chat UI, auth, admin dashboards
└── episteme-core/     # Mastra back-end — agent, tools, workflows, knowledge base
```

## Sub-project READMEs

- [episteme-chat/README.md](episteme-chat/README.md) — Front-end setup and development guide
- [episteme-core/README.md](episteme-core/README.md) — Back-end (Mastra) setup and development guide

---

## Tech stack

| Layer | Technology |
|---|---|
| Front-end | Next.js 15, Tailwind CSS, assistant-ui |
| Back-end / Agent | Mastra, Mistral (mistral-small-2603) |
| Knowledge retrieval | Hybrid vector + keyword search (pgvector) |
| Database / Storage | Supabase (LibSQL for Mastra state) |
| Auth | Supabase Auth |
| Claim workflow | Mastra suspend/resume workflow |
| Observability | Mastra Observability + Pino |

---

## Quick start

Install all dependencies from the root:

```bash
install.bat   # Windows — installs deps for both sub-projects
```

Then start each sub-project in its own terminal:

```bash
# Back-end (port 4111)
cd episteme-core && pnpm dev

# Front-end (port 3000)
cd episteme-chat && pnpm dev
```
