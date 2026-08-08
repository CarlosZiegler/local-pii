export async function settleChatStop(
  stop: () => Promise<void>
): Promise<Error | undefined> {
  try {
    await stop()
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "name" in cause &&
      cause.name === "AbortError"
    ) {
      return undefined
    }
    return cause instanceof Error ? cause : new Error(String(cause))
  }
  return undefined
}
