import Link from 'next/link';
import { Cpu, Wrench, Plug, Feather, ArrowRight } from 'lucide-react';
import { Hero } from '@/components/hero';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const FEATURES = [
  {
    icon: Cpu,
    title: 'On-device model',
    body: 'A 14.7 MB Rampart model runs in your app or the browser — names, addresses and IDs, fully offline.',
  },
  {
    icon: Wrench,
    title: 'Tool calls, solved',
    body: 'Placeholders survive JSON and tool-call arguments. Your tools run with real values; the provider never sees them.',
  },
  {
    icon: Plug,
    title: 'Any LLM',
    body: 'Drop-in adapters for the Vercel AI SDK and OpenAI / Grok. Anonymize, call, rehydrate — you barely change your code.',
  },
  {
    icon: Feather,
    title: 'Zero-dep core',
    body: 'The detection + placeholder core has no runtime dependencies and runs in React Native, the browser and Node.',
  },
];

export default function HomePage() {
  return (
    <main className="flex-1">
      <Hero />

      <section className="mx-auto max-w-4xl px-6 py-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y py-4 font-mono text-sm text-muted-foreground">
          <span className="text-xs uppercase tracking-wider">runs on</span>
          <span>Expo / React Native</span>
          <span className="text-border">·</span>
          <span>Browser</span>
          <span className="text-border">·</span>
          <span>Node</span>
        </div>
      </section>

      <section className="mx-auto grid max-w-4xl gap-4 px-6 py-6 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <Card key={f.title} className="p-5">
            <f.icon className="size-5 text-muted-foreground" />
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
          </Card>
        ))}
      </section>

      <section className="mx-auto max-w-4xl px-6 py-8">
        <pre className="overflow-x-auto rounded-xl border bg-card p-5 font-mono text-xs leading-6 text-muted-foreground">
{`note ─▶ rules (email · phone · card · IBAN · SSN · IP)
     ─▶ your dictionary
     ─▶ Rampart NER (names · addresses · IDs)
     ─▶ placeholders ─▶ LLM
                          │
        reply ─▶ rehydrate(reply) ─▶ restored text`}
        </pre>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-12">
        <Card className="flex flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-mono text-xl font-semibold tracking-tight">See it redact, live.</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Type a note and watch PII turn to placeholders in your browser — the model runs on device.
            </p>
          </div>
          <Button asChild size="lg" className="shrink-0">
            <Link href="/docs/playground">
              Open the playground <ArrowRight className="size-4" />
            </Link>
          </Button>
        </Card>
      </section>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
          <span className="font-mono">local-pii</span>
          <div className="flex gap-4">
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <Link href="/docs/playground" className="hover:text-foreground">Playground</Link>
            <a href="https://github.com/CarlosZiegler/local-pii" className="hover:text-foreground">GitHub</a>
          </div>
          <span className="text-xs">MIT · model CC BY 4.0</span>
        </div>
      </footer>
    </main>
  );
}
