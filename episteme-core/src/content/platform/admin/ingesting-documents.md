---
docId: platform-admin-ingesting-documents
title: Adding documents to the knowledge base
namespace: platform-admin
roles: [staff, hod]
updated: 2026-07-28
---

# Adding documents to the knowledge base

Episteme answers only from documents that have been ingested. It has no
knowledge of your institution beyond what you load, and it will say so rather
than guess when it finds nothing.

## Ways to add a document

**Upload a file.** Admin → Knowledge Base → Add Document. PDF, DOCX, HTML, and
scanned images are accepted; text is extracted, split into chunks, and indexed.

**Paste text or Markdown.** Suitable for announcements, FAQs, and anything that
has no source file. Text-based documents can be re-ingested later without
re-uploading, which file uploads cannot.

**Ingest from a URL.** Supply a page address on your institution's domain and
the page is fetched and treated exactly as an uploaded HTML file. The address it
came from is recorded, so a later freshness check can re-fetch it, compare, and
re-ingest only if the page has actually changed.

## Fields you set, and what each one does

**Namespace** is the retrieval partition and the single most consequential
choice. It decides which trust levels can reach the document at all:

| Namespace | Reachable from |
|---|---|
| Admissions, Programmes, General | Trust 1 and above — effectively public |
| Academic Policy, Financial Aid | Trust 3 and above — verified students, staff |
| Staff Internal | Trust 4 only — staff, HODs, administrators |

Filing a document in the wrong namespace is a confidentiality problem, not an
untidiness problem. A fees document placed in *General* is readable by every
unverified visitor, because *General* is a trust-1 namespace — the restriction
you intended by calling it financial information is carried by the namespace,
not by the document's subject matter.

**Roles** are the second gate: only users holding one of these roles can match
the document. Tag every role that should legitimately see it.

**Content date** is the document's own editorial date — when the content was
written or last revised, not today. Documents older than a year are flagged as
possibly outdated, and the assistant then prefers a fresher source and warns the
reader. Setting this to today's date on an old handbook defeats that protection
and lets a stale fact be presented as current.

**Programme** and **level** are optional narrowing. Leave them empty for
anything faculty-wide: an unscoped document is returned to everyone, whereas a
scoped one is withheld from users who do not match.

## Replacing and removing

Re-ingesting a document replaces its previous version completely — old chunks
are deleted first, so nothing is left behind to be retrieved. Deleting removes
it from the index immediately.

Editing a document's scope (roles, level, programme, category, or content date)
applies without re-processing the file. One limitation: a document that has been
narrowed to specific levels or programmes can be re-scoped to a different set,
but cannot be widened back to "applies to everyone" that way. Returning it to
unscoped requires a full re-ingest.

## Verifying that it worked

Ask the assistant a question the document answers, from an account with the role
and trust level you intended. Retrieval is relevance-gated: a document that is
present but only loosely related will not be returned, and the assistant will
say it has no verified information rather than offer a weak match. If a document
you expect is not being used, confirm the namespace and roles first — those are
the two settings that silently exclude it.
