export function isExpectedChatCancellation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause.name === "AbortError" || cause.name === "LocalChatStop")
  )
}

export async function settleChatStop(
  stop: () => Promise<void>
): Promise<Error | undefined> {
  try {
    await stop()
  } catch (cause) {
    if (isExpectedChatCancellation(cause)) {
      return undefined
    }
    return cause instanceof Error ? cause : new Error(String(cause))
  }
  return undefined
}
