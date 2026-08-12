import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PrivacyInspector } from "./privacy-inspector"
import type { PrivacyInspection } from "./protection-observer"

describe("PrivacyInspector", () => {
  it("renders only the committed protected request and its run summary", () => {
    const inspection: PrivacyInspection = {
      generationRunId: "run-42",
      counts: { EMAIL: 1 },
      protectedHistory: [
        { role: "user", protectedContent: "Earlier [EMAIL_1]" },
      ],
      protectedContent: "Current [EMAIL_1]",
    }

    render(<PrivacyInspector inspection={inspection} runtimeName="Gemma" />)

    expect(screen.getByText("run-42")).toBeInTheDocument()
    expect(screen.getByText("EMAIL: 1")).toBeInTheDocument()
    expect(screen.getByText("Earlier [EMAIL_1]")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Current protected content")
    ).toHaveTextContent("Current [EMAIL_1]")
    expect(screen.queryByText("ana@example.com")).not.toBeInTheDocument()
  })

  it("has a readable empty state", () => {
    render(<PrivacyInspector runtimeName="Gemma" />)

    expect(
      screen.getByText("No generation run has been committed yet.")
    ).toBeInTheDocument()
    expect(screen.getByText("No prompt sent yet.")).toBeInTheDocument()
  })

  it("distinguishes a committed run without detected personal information", () => {
    render(
      <PrivacyInspector
        inspection={{
          generationRunId: "run-empty",
          counts: {},
          protectedHistory: [],
          protectedContent: "hello",
        }}
        runtimeName="Gemma"
      />
    )

    expect(
      screen.getByText(
        "No personal information was detected in this generation run."
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText("No generation run has been committed yet.")
    ).not.toBeInTheDocument()
  })
})
