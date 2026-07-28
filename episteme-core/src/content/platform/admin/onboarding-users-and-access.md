---
docId: platform-admin-onboarding-users-and-access
title: Onboarding users and setting access levels
namespace: platform-admin
roles: [staff, hod]
updated: 2026-07-28
---

# Onboarding users and setting access levels

This describes how to add people to Episteme and control what the assistant will
retrieve for them. It covers the platform only — it is not your institution's HR
or staff-induction policy.

## The two things that control access

Every answer Episteme gives is filtered by two independent gates. Both apply to
every question; neither can override the other.

**Role** determines which categories of document a person can match. A document
is tagged with the roles allowed to see it, and a user matches if any of their
roles is in that list. The roles are `prospective`, `student`, `parent`,
`staff`, and `hod`.

**Trust level** is a hard ceiling on top of role, from 1 to 4:

| Trust | Meaning | Adds access to |
|---|---|---|
| 1 | Unverified / public | Admissions, programmes, general information |
| 2 | Unverified student | Same as level 1 |
| 3 | Portal-verified student | Academic policy, financial aid |
| 4 | Staff, HOD, or administrator | Staff-internal documents |

A person claiming a role they have not been granted cannot reach anything: the
result is the *intersection* of what the role allows and what the trust level
permits. Someone recorded as staff but sitting at trust 1 retrieves public
documents only.

## Adding a staff member

1. Open **Admin → Users** and choose **Invite**.
2. Enter their institutional email address. Invitations are single-use and
   expire; an expired invitation must be reissued rather than resent.
3. Set their primary role to `staff`, or `hod` if they head a department.
4. Save. The account is created when they accept the invitation and sign in.

Staff and HOD accounts are placed at trust level 4 automatically on the strength
of the verified role. You do not set trust level by hand for them, and you
should not attempt to — the value stored against a user profile is ignored for
these roles precisely so that it cannot be raised from the user's own side.

## Giving someone more than one role

A person can legitimately hold several roles — a lecturer who is also enrolled
on a postgraduate programme, or an administrator who is also a student. Add
every role that genuinely applies rather than picking the most senior one.

Access is the **union** of all their roles, so adding a role never removes
anything. Assigning only the most senior role has the opposite of the intended
effect: an administrator recorded solely as an administrator loses the
student-tagged documents they would otherwise reach.

## Account status

An account must be `active` to use the assistant. Suspending an account blocks
it at sign-in, ahead of any retrieval, so suspension takes effect immediately
rather than at the next session.

## What to check when someone reports missing information

Work through the gates in this order:

1. **Their role.** Does any role they hold appear in the document's role tags?
2. **Their trust level.** Level 3 content is invisible at level 2, whatever the
   role says.
3. **The document's own tags.** A document scoped to a programme or level is
   only returned to matching users, or to users whose query names that scope.
4. **The institution.** Documents are isolated per institution. A user only ever
   sees their own institution's documents plus those shared platform-wide.

If all four are correct and the information is still missing, the document is
most likely not in the knowledge base at all — see *Ingesting documents*.
