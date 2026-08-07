import { describe, expect, it } from "vitest"
import { ipDetector } from "./ip"
import { phoneDetector } from "./phone"
import { ssnDetector } from "./ssn"
import { urlDetector } from "./url"

describe("ssnDetector", () => {
  it("detects a valid hyphenated SSN", () => {
    const [span] = ssnDetector.detect("SSN 123-45-6789 on record")
    expect(span?.type).toBe("SSN")
    expect(span?.text).toBe("123-45-6789")
  })

  it("rejects reserved area numbers", () => {
    expect(ssnDetector.detect("000-12-3456")).toEqual([])
    expect(ssnDetector.detect("666-12-3456")).toEqual([])
    expect(ssnDetector.detect("900-12-3456")).toEqual([])
  })
})

describe("ipDetector", () => {
  it("detects a valid IPv4 address", () => {
    expect(ipDetector.detect("host 192.168.0.1 up")[0]?.text).toBe("192.168.0.1")
  })

  it("rejects an out-of-range IPv4 address", () => {
    expect(ipDetector.detect("299.1.1.1")).toEqual([])
  })

  it("detects an IPv6 address", () => {
    const [span] = ipDetector.detect("addr 2001:db8:0:0:0:0:2:1 here")
    expect(span?.type).toBe("IP_ADDRESS")
    expect(span?.text).toBe("2001:db8:0:0:0:0:2:1")
  })
})

describe("urlDetector", () => {
  it("detects an https URL without swallowing the trailing period", () => {
    const [span] = urlDetector.detect("see https://example.com/path?x=1.")
    expect(span?.type).toBe("URL")
    expect(span?.text).toBe("https://example.com/path?x=1")
  })

  it("detects a bare www host", () => {
    expect(urlDetector.detect("go to www.acme.io now")[0]?.text).toBe("www.acme.io")
  })
})

describe("phoneDetector", () => {
  it("detects an international number with spaces", () => {
    const [span] = phoneDetector.detect("call me on +49 151 12345678 please")
    expect(span?.type).toBe("PHONE")
    expect(span?.text).toBe("+49 151 12345678")
  })

  it("detects a US number with parentheses and hyphens", () => {
    expect(phoneDetector.detect("(030) 555-1234 ext")[0]?.text).toBe("(030) 555-1234")
  })

  it("ignores short numbers like years", () => {
    expect(phoneDetector.detect("in 2026 we ship")).toEqual([])
  })
})
