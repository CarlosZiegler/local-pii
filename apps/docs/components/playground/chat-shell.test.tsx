import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ChatShell } from "./chat-shell"

describe("ChatShell lifecycle controls", () => {
  it("supports async reset/stop actions and disables controls while resetting", () => {
    render(
      <ChatShell
        framework="Vercel"
        messages={[]}
        onNewChat={vi.fn(async () => {})}
        onStop={vi.fn(async () => {})}
        onSubmit={vi.fn(async () => {})}
        resetting
        runtimeName="Test"
        status="ready"
      />
    )

    expect(
      screen.getByRole("button", { name: "Start a new chat" })
    ).toBeDisabled()
    expect(screen.getByLabelText("Message")).toBeDisabled()
  })

  it("keeps Stop accessible while generation is streaming", () => {
    render(
      <ChatShell
        framework="Vercel"
        messages={[]}
        onNewChat={vi.fn(async () => {})}
        onStop={vi.fn(async () => {})}
        onSubmit={vi.fn(async () => {})}
        runtimeName="Test"
        status="streaming"
      />
    )

    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled()
    expect(screen.getByLabelText("Message")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Start a new chat" })
    ).toBeDisabled()
  })

  it("disables every control while Stop awaits generation cleanup", () => {
    render(
      <ChatShell
        framework="Vercel"
        messages={[]}
        onNewChat={vi.fn(async () => {})}
        onStop={vi.fn(async () => {})}
        onSubmit={vi.fn(async () => {})}
        runtimeName="Test"
        status="ready"
        stopping
      />
    )

    expect(screen.getByText("Stopping generation run…")).toBeVisible()
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled()
    expect(screen.getByLabelText("Message")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Start a new chat" })
    ).toBeDisabled()
  })
})
