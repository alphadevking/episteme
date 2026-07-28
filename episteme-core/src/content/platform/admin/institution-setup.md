---
docId: platform-admin-institution-setup
title: Setting up your institution
namespace: platform-admin
roles: [staff, hod]
updated: 2026-07-28
---

# Setting up your institution

The order below matters: each step depends on the one before it, and loading
documents before the institution record exists will tag them as globally shared
rather than as yours.

## 1. The institution record

Everything in Episteme is scoped to an institution. Every document is stored
against either a specific institution or the shared platform-wide pool, and
every query is filtered to the caller's own institution plus that shared pool.
One institution can never retrieve another's documents, and this filter cannot
be disabled or overridden from a question.

Create the institution record first, before ingesting anything.

## 2. Faculties, departments, and programmes

Add the academic structure next. These become the programme and level scopes you
can attach to documents, so a document loaded before its programme exists cannot
be scoped to it without re-ingesting.

Leave scopes off anything that genuinely applies institution-wide. An unscoped
document is returned to every user; a scoped one is withheld from users who do
not match, which is the more common cause of "the assistant can't find our
policy" than a missing document.

## 3. Administrators and staff

Invite the people who will operate the system. See *Onboarding users and setting
access levels* for roles, trust levels, and what to do for someone who holds
more than one role.

## 4. The initial document set

Load documents in the order that reflects who is waiting for them. In practice
that means admissions and programme information first — those are reachable by
unverified visitors and carry most early questions — then academic policy and
financial information for verified students, then internal material.

Check coverage per namespace rather than per document. A namespace with nothing
in it is not neutral: every question that should have been answered from it
abstains, and the user is told no verified information exists. That is
indistinguishable, from their side, from the system being broken.

## 5. Verify before announcing

From a test account at each trust level you support, ask a question that should
be answered at that level and one that should not. What you are confirming is
both directions: that the right information is reachable, and that information
above the account's level is not.
