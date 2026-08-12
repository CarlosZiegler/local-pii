import Link from "next/link"
import type { Metadata } from "next"
import { Cpu, Wrench, Plug, Feather, ArrowRight } from "lucide-react"
import { Hero } from "@/components/hero"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getLanding } from "@/lib/landing-i18n"

const ICONS = [Cpu, Wrench, Plug, Feather]

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>
}): Promise<Metadata> {
  const { lang } = await params
  const s = getLanding(lang)
  return { title: "local-pii", description: s.sub }
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const { lang } = await params
  const s = getLanding(lang)
  return (
    <main className="flex-1">
      <Hero lang={lang} />

      <section className="mx-auto max-w-4xl px-6 py-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y py-4 font-mono text-sm text-muted-foreground">
          <span className="text-xs tracking-wider uppercase">{s.runsOn}</span>
          <span>Expo / React Native</span>
          <span className="text-border">·</span>
          <span>Browser</span>
          <span className="text-border">·</span>
          <span>Node</span>
        </div>
      </section>

      <section className="mx-auto grid max-w-4xl gap-4 px-6 py-6 sm:grid-cols-2">
        {s.features.map((f, i) => {
          const Icon = ICONS[i]!
          return (
            <Card key={f.title} className="p-5">
              <Icon className="size-5 text-muted-foreground" />
              <h3 className="mt-3 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </Card>
          )
        })}
      </section>

      <section className="mx-auto max-w-4xl px-6 py-8">
        <pre className="overflow-x-auto rounded-xl border bg-card p-5 font-mono text-xs leading-6 text-muted-foreground">
          {s.pipeline}
        </pre>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-12">
        <Card className="flex flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-mono text-xl font-semibold tracking-tight">
              {s.ctaTitle}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{s.ctaBody}</p>
          </div>
          <Button asChild size="lg" className="shrink-0">
            <Link href={`/${lang}/docs/playground`}>
              {s.ctaBtn} <ArrowRight className="size-4" />
            </Link>
          </Button>
        </Card>
      </section>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
          <span className="font-mono">local-pii</span>
          <div className="flex gap-4">
            <Link href={`/${lang}/docs`} className="hover:text-foreground">
              Docs
            </Link>
            <Link
              href={`/${lang}/docs/playground`}
              className="hover:text-foreground"
            >
              Playground
            </Link>
            <a
              href="https://github.com/CarlosZiegler/local-pii"
              className="hover:text-foreground"
            >
              GitHub
            </a>
          </div>
          <span className="text-xs">{s.license}</span>
        </div>
      </footer>
    </main>
  )
}
