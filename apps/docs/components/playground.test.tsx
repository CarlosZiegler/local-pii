import { describe, expect, it } from "vitest"
import { runtimeChoiceAriaLabel } from "./playground/runtime-choice"

const option = {
  kind: "gemini-nano" as const,
  disclosure: {
    label: "Chrome built-in Prompt API",
    model: "Gemini Nano",
    source: "Chrome built-in Prompt API",
    artifacts: { kind: "browser-managed" as const },
  },
}

describe("runtime choice accessibility", () => {
  it("names unavailable choices with their visible state and runtime", () => {
    expect(
      runtimeChoiceAriaLabel({ ...option, availability: "unavailable" })
    ).toBe("Unavailable Chrome built-in Prompt API")
  })

  it("keeps activation and cached action names aligned with visible labels", () => {
    expect(
      runtimeChoiceAriaLabel({ ...option, availability: "requires-activation" })
    ).toBe("Activate Chrome built-in Prompt API")
    expect(runtimeChoiceAriaLabel({ ...option, availability: "ready" })).toBe(
      "Use Chrome built-in Prompt API"
    )
  })
})
