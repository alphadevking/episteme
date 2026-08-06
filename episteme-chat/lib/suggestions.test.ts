// lib/suggestions.test.ts
// The suggestion filter decides what the product PROMISES a user it can answer.
// Every assertion below is about not over-promising: each failure mode here
// spends a user's first click on a refusal.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getSuggestions, CATALOGUE, MAX_SUGGESTIONS } from "./suggestions";

const ids = (s: { id: string }[]) => s.map((x) => x.id).sort();

describe("catalogue integrity", () => {
  test("every entry carries the evidence the admission rule requires", () => {
    for (const entry of CATALOGUE) {
      assert.ok(entry.id,             `entry missing id: ${JSON.stringify(entry)}`);
      assert.ok(entry.label.trim(),   `${entry.id}: empty label`);
      assert.ok(entry.prompt.trim(),  `${entry.id}: empty prompt`);
      assert.ok(entry.roles.length,   `${entry.id}: no roles — would be invisible to everyone`);
      assert.ok(entry.namespace,      `${entry.id}: no namespace — allowlist filtering can't apply`);
      assert.ok(
        entry.expectedSource.trim(),
        `${entry.id}: no expectedSource — the eval cannot assert this chip still works`,
      );
      assert.ok(
        entry.why.trim().length > 40,
        `${entry.id}: 'why' must record WHY this is answerable, not just assert it`,
      );
      assert.ok(
        entry.minTrust >= 1 && entry.minTrust <= 4,
        `${entry.id}: minTrust ${entry.minTrust} outside the trust ladder`,
      );
    }
  });

  test("ids are unique", () => {
    const seen = new Set(CATALOGUE.map((e) => e.id));
    assert.equal(seen.size, CATALOGUE.length, "duplicate suggestion id");
  });
});

describe("trust ceiling", () => {
  test("an unverified student is never offered a chip above their ceiling", () => {
    const shown = getSuggestions({ roles: ["student"], trustLevel: 2 });
    for (const chip of shown) {
      const entry = CATALOGUE.find((e) => e.id === chip.id)!;
      assert.ok(entry.minTrust <= 2, `${chip.id} needs trust ${entry.minTrust} but was shown at 2`);
    }
  });

  test("a bogus trust level fails closed to 1, never upward", () => {
    const bogus = getSuggestions({ roles: ["staff"], trustLevel: 99 as number, isPlatformAdmin: true });
    for (const chip of bogus) {
      const entry = CATALOGUE.find((e) => e.id === chip.id)!;
      assert.ok(entry.minTrust <= 4, `${chip.id} escaped the clamp`);
    }
    // Missing trust behaves as the floor.
    const missing = getSuggestions({ roles: ["staff"], isPlatformAdmin: true });
    for (const chip of missing) {
      const entry = CATALOGUE.find((e) => e.id === chip.id)!;
      assert.equal(entry.minTrust, 1, `${chip.id} shown without a known trust level`);
    }
  });
});

describe("platform-operator bit", () => {
  test("operator chips are hidden from a non-operator at full trust", () => {
    const shown = getSuggestions({ roles: ["staff"], trustLevel: 4, isPlatformAdmin: false });
    for (const chip of shown) {
      const entry = CATALOGUE.find((e) => e.id === chip.id)!;
      assert.ok(
        !entry.requiresPlatformAdmin,
        `${chip.id} is operator-only but was shown without the bit — the golden set ` +
        `asserts that exact query must abstain, so this chip would always fail`,
      );
    }
  });

  test("an operator does see them", () => {
    const shown = getSuggestions({ roles: ["staff"], trustLevel: 4, isPlatformAdmin: true });
    assert.ok(
      shown.some((c) => CATALOGUE.find((e) => e.id === c.id)?.requiresPlatformAdmin),
      "operator saw no operator chips",
    );
  });
});

describe("record-level role metadata, not just the namespace grant", () => {
  test("an HOD is not offered the admissions chip", () => {
    // The HOD holds the `admissions` NAMESPACE via ROLE_NAMESPACES, but every
    // record in it is tagged prospective/student/parent/staff — so retrieval
    // returns nothing. Filtering on the namespace grant alone would ship a chip
    // that fails for HODs and nobody else, which is the hardest kind to notice.
    const shown = getSuggestions({ roles: ["hod"], trustLevel: 4 });
    assert.ok(
      !shown.some((c) => c.id === "kb-admission-requirements"),
      "HOD offered a chip whose backing records exclude the hod role",
    );
  });

  test("the roles that DO match still get it", () => {
    for (const role of ["prospective", "student", "parent", "staff"]) {
      const shown = getSuggestions({ roles: [role], trustLevel: 1 });
      assert.ok(
        shown.some((c) => c.id === "kb-admission-requirements"),
        `${role} lost the admissions chip`,
      );
    }
  });
});

describe("parent link allowlist", () => {
  test("narrows institutional chips but never platform ones", () => {
    // A parent with neither fee nor academic permission.
    const shown = getSuggestions({
      roles:              ["parent"],
      trustLevel:         3,
      namespaceAllowlist: ["admissions", "general"],
    });

    assert.ok(
      shown.some((c) => c.id === "platform-getting-started"),
      "the allowlist stripped a parent's ability to ask how the product works — " +
      "platform docs are resolved on their own axis and must not be narrowed",
    );

    for (const chip of shown) {
      const entry = CATALOGUE.find((e) => e.id === chip.id)!;
      if (entry.tier === "kb") {
        assert.ok(
          ["admissions", "general"].includes(entry.namespace),
          `${chip.id} sits in ${entry.namespace}, outside this parent's allowlist`,
        );
      }
    }
  });

  test("an empty allowlist means 'not supplied', not 'deny everything'", () => {
    const shown = getSuggestions({ roles: ["student"], trustLevel: 2, namespaceAllowlist: [] });
    assert.ok(shown.length > 0, "empty allowlist wrongly denied every chip");
  });
});

describe("shape", () => {
  test("never exceeds the grid", () => {
    const shown = getSuggestions({ roles: ["staff", "student"], trustLevel: 4, isPlatformAdmin: true });
    assert.ok(shown.length <= MAX_SUGGESTIONS, `returned ${shown.length} chips`);
  });

  test("every role that can sign in gets at least one answerable chip", () => {
    // Falling to zero chips is a blank welcome screen. The platform-help entry
    // exists precisely so no role bottoms out.
    for (const role of ["prospective", "student", "parent", "staff", "hod"]) {
      const shown = getSuggestions({ roles: [role], trustLevel: 1 });
      assert.ok(shown.length > 0, `${role} got no suggestions at all`);
    }
  });

  test("unknown roles degrade to prospective rather than blanking", () => {
    assert.deepEqual(
      ids(getSuggestions({ roles: [] })),
      ids(getSuggestions({ roles: ["prospective"], trustLevel: 1 })),
    );
  });
});
