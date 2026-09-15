import { describe, expect, test } from "bun:test";

import { readConfig } from "../src/config.ts";
import { loadSeed } from "../src/policy-store.ts";

describe("persona email configuration", () => {
  test("maps the role variables into the seeded persona keys", () => {
    const config = readConfig({
      LOAN_APP_PUBLIC_HOST: "localhost:1",
      PERSONA_LOAN_OFFICER_EMAIL: "  Alice@Example.com ",
      PERSONA_CREDIT_ANALYST_EMAIL: "bob@example.com",
      PERSONA_VP_CREDIT_EMAIL: "charlie@example.com",
      PERSONA_CHIEF_CREDIT_OFFICER_EMAIL: "michael@example.com",
    });

    const seed = loadSeed(config);
    expect(seed.subjects.map((subject) => subject.user_id).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com",
      "michael@example.com",
    ]);
  });

  test("rejects a deprecated name variable before governance.db can seed fixtures", () => {
    expect(() =>
      readConfig({
        LOAN_APP_PUBLIC_HOST: "localhost:1",
        PERSONA_DANA_EMAIL: "dana@example.com",
      }),
    ).toThrow(/PERSONA_DANA_EMAIL.*PERSONA_LOAN_OFFICER_EMAIL/);
  });

  test("rejects an unknown persona email variable instead of ignoring a typo", () => {
    expect(() =>
      readConfig({
        LOAN_APP_PUBLIC_HOST: "localhost:1",
        PERSONA_LOAN_OFFCER_EMAIL: "dana@example.com",
      }),
    ).toThrow(/PERSONA_LOAN_OFFCER_EMAIL/);
  });
});
