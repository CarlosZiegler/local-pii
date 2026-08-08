import { describe, expect, it } from "vitest"
import { settleChatStop } from "./settle-chat-stop"

describe("settleChatStop", () => {
  it("treats AbortError as expected cancellation", async () => {
    const abort = new DOMException(
      "signal is aborted without reason",
      "AbortError"
    )

    await expect(
      settleChatStop(async () => {
        throw abort
      })
    ).resolves.toBeUndefined()
  })

  it("returns unexpected stop failures for the UI", async () => {
    await expect(
      settleChatStop(async () => {
        throw new Error("stop failed")
      })
    ).resolves.toEqual(new Error("stop failed"))
  })
})
