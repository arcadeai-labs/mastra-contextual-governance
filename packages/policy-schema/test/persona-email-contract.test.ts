import { describe, expect, test } from "bun:test";

import {
  PERSONA_EMAIL_CONTRACT,
  personaEmailVariable,
  readPersonaEmailOverrides,
} from "../contract/persona-email-contract.ts";

describe("the shared persona email contract", () => {
  test("maps every fixture key to its role variable explicitly", () => {
    expect(PERSONA_EMAIL_CONTRACT.map(({ key, variable }) => [key, variable])).toEqual([
      ["dana", "PERSONA_LOAN_OFFICER_EMAIL"],
      ["sam", "PERSONA_CREDIT_ANALYST_EMAIL"],
      ["riley", "PERSONA_VP_CREDIT_EMAIL"],
      ["morgan", "PERSONA_CHIEF_CREDIT_OFFICER_EMAIL"],
    ]);
    expect(personaEmailVariable("morgan")).toBe("PERSONA_CHIEF_CREDIT_OFFICER_EMAIL");
  });

  test("trims configured values but leaves lowercasing to each identity store", () => {
    expect(
      readPersonaEmailOverrides({
        PERSONA_LOAN_OFFICER_EMAIL: "  Alice@Example.com  ",
      }),
    ).toEqual({ dana: "Alice@Example.com" });
  });

  test("rejects deprecated and unknown variables", () => {
    expect(() => readPersonaEmailOverrides({ PERSONA_DANA_EMAIL: "dana@example.com" })).toThrow(
      /PERSONA_DANA_EMAIL.*PERSONA_LOAN_OFFICER_EMAIL/,
    );
    expect(() => readPersonaEmailOverrides({ PERSONA_LOAN_OFFCER_EMAIL: "dana@example.com" })).toThrow(
      /PERSONA_LOAN_OFFCER_EMAIL/,
    );
  });
});
