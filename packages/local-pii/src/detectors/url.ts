import { makeRegexDetector } from "./_util"

/**
 * `http(s)://…` or `www.…`. The final character class stops the match before
 * trailing sentence punctuation so "see https://a.com." keeps the period out.
 */
const CANDIDATE = /(?:https?:\/\/|www\.)[^\s]*[^\s.,;:!?)\]}'"<>]/gu

export const urlDetector = makeRegexDetector({
  name: "url",
  type: "URL",
  pattern: CANDIDATE,
})
