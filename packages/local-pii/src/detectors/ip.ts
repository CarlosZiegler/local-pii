import { makeRegexDetector } from "./_util"

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b/
const CANDIDATE = new RegExp(`${IPV4.source}|${IPV6.source}`, "g")

function ipv4Valid(value: string): boolean {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number(p)
    return n >= 0 && n <= 255
  })
}

export const ipDetector = makeRegexDetector({
  name: "ip",
  type: "IP_ADDRESS",
  pattern: CANDIDATE,
  validate: (m) => {
    const v = m[0]
    // IPv4 needs octet-range validation; IPv6 candidates need a real `:`.
    if (v.includes(".") && !v.includes(":")) return ipv4Valid(v)
    return v.includes(":") && /[0-9a-fA-F]/.test(v)
  },
})
