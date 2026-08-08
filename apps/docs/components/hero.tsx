"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowRight, Check, Copy, MessagesSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getLanding } from "@/lib/landing-i18n"

type Seg = { t: string; pii?: string }

const EXAMPLES: Seg[][] = [
  [
    { t: "Ontem encontrei " },
    { t: "João Silva", pii: "[GIVEN_NAME_1] [SURNAME_1]" },
    { t: ". Tel " },
    { t: "+49 151 12345678", pii: "[PHONE_1]" },
    { t: "." },
  ],
  [
    { t: "Email " },
    { t: "ana@acme.com", pii: "[EMAIL_1]" },
    { t: " re: fatura " },
    { t: "DE89 3704 0044 0532", pii: "[IBAN_1]" },
  ],
  [
    { t: "Paciente " },
    { t: "Tomás", pii: "[GIVEN_NAME_1]" },
    { t: ", cartão " },
    { t: "4111 1111 1111 1111", pii: "[CREDIT_CARD_1]" },
  ],
]

function Panel({ segs, redacted }: { segs: Seg[]; redacted: boolean }) {
  return (
    <p className="font-mono text-sm leading-7 sm:text-[0.95rem]">
      {segs.map((s, i) =>
        s.pii ? (
          redacted ? (
            <span
              key={i}
              className="rounded bg-emerald-500/12 px-1 text-emerald-700 dark:text-emerald-400"
            >
              {s.pii}
            </span>
          ) : (
            <mark
              key={i}
              className="rounded bg-amber-500/20 px-0.5 text-amber-800 dark:bg-amber-400/20 dark:text-amber-300"
            >
              {s.t}
            </mark>
          )
        ) : (
          <span key={i} className="text-muted-foreground">
            {s.t}
          </span>
        )
      )}
    </p>
  )
}

function Membrane() {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const id = setInterval(() => setI((x) => (x + 1) % EXAMPLES.length), 3600)
    return () => clearInterval(id)
  }, [])
  const segs = EXAMPLES[i]!

  return (
    <div className="rounded-2xl border bg-card p-1 shadow-sm">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl md:grid-cols-[1fr_auto_1fr]">
        {/* on device */}
        <div className="bg-background p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-emerald-500" /> on your
            device
          </div>
          <Panel segs={segs} redacted={false} />
        </div>

        {/* the membrane */}
        <div className="relative flex items-center justify-center bg-background px-2 py-3 md:flex-col">
          <div className="absolute inset-x-4 top-1/2 h-px bg-gradient-to-r from-transparent via-amber-500/50 to-transparent md:inset-x-auto md:inset-y-4 md:left-1/2 md:h-auto md:w-px md:bg-gradient-to-b" />
          <span className="relative rounded-full border border-amber-500/40 bg-background px-2 py-0.5 font-mono text-[0.62rem] tracking-wider text-amber-600 uppercase dark:text-amber-400">
            leaves →
          </span>
        </div>

        {/* what the LLM sees */}
        <div className="bg-background p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-amber-500" /> what the LLM
            sees
          </div>
          <Panel segs={segs} redacted />
        </div>
      </div>
    </div>
  )
}

function Install() {
  const [copied, setCopied] = useState(false)
  const cmd = "bun add local-pii"
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(cmd)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
      className="group inline-flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 font-mono text-sm shadow-sm transition hover:bg-accent"
    >
      <span className="text-muted-foreground">$</span>
      <span>{cmd}</span>
      {copied ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <Copy className="size-4 text-muted-foreground" />
      )}
    </button>
  )
}

export function Hero({ lang = "en" }: { lang?: string }) {
  const s = getLanding(lang)
  return (
    <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 sm:pt-24">
      <div className="mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {s.eyebrow}
      </div>

      <h1 className="max-w-2xl font-mono text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
        {s.h1}
      </h1>

      <p className="mt-5 max-w-xl text-lg text-muted-foreground">{s.sub}</p>

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Install />
        <Button asChild size="lg">
          <Link href={`/${lang}/docs`}>
            {s.docs} <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href={`/${lang}/docs/playground`}>
            <MessagesSquare className="size-4" /> {s.chat}
          </Link>
        </Button>
      </div>

      <div className="mt-12">
        <Membrane />
      </div>
    </section>
  )
}
