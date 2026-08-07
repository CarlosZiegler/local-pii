/**
 * A stand-in "LLM" that echoes the placeholders back, so you can see
 * rehydration restore the originals on device. Swap `callMockLlm` for a real
 * OpenAI/Claude-compatible call — only the already-anonymized text is sent.
 */
export async function callMockLlm(anonymizedPrompt: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 350))
  return (
    `Here's a short reply based on your note:\n\n` +
    `"${anonymizedPrompt}"\n\n` +
    `Notice every [PLACEHOLDER] above — those are all the model ever saw.`
  )
}

/**
 * Example of a real call. The key and network only ever see `anonymizedPrompt`.
 *
 * export async function callOpenAi(anonymizedPrompt: string, apiKey: string) {
 *   const res = await fetch("https://api.openai.com/v1/chat/completions", {
 *     method: "POST",
 *     headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
 *     body: JSON.stringify({
 *       model: "gpt-4o-mini",
 *       messages: [{ role: "user", content: anonymizedPrompt }],
 *     }),
 *   })
 *   const json = await res.json()
 *   return json.choices[0].message.content as string
 * }
 */
