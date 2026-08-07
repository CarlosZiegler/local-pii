'use client';

import { useMemo, useRef, useState } from 'react';
import { createAnonymizer, rehydrate, type Entity, type NerBackend } from 'local-pii';
import { ArrowUp, Plus, ShieldCheck, X, Bot, User, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface Turn {
  original: string;
  redacted: string;
  entities: Entity[];
  rehydrated: string;
}

const SAMPLE =
  'Resumo do meu filho Tomás: consulta com a Dra. Beatriz, email ana.souza@gmail.com, ' +
  'tel +55 11 91234-5678, tomando Amoxicilina para dor de ouvido.';

const TOKEN = /\[[A-Z0-9_]+_\d+\]|PII[0-9A-HJKMNP-TV-Z]+/g;

const SOURCE_STYLE: Record<Entity['source'], string> = {
  deterministic: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
  ner: 'border-purple-500/40 text-purple-600 dark:text-purple-400',
  dictionary: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
};

function Tokens({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  const toks = text.match(TOKEN) ?? [];
  return (
    <span className="leading-relaxed">
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {toks[i] && (
            <mark className="mx-px rounded bg-amber-500/15 px-1 font-mono text-[0.82em] text-amber-700 dark:text-amber-400">
              {toks[i]}
            </mark>
          )}
        </span>
      ))}
    </span>
  );
}

export function Playground() {
  const [terms, setTerms] = useState<string[]>([]);
  const [termInput, setTermInput] = useState('');
  const [input, setInput] = useState(SAMPLE);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ner, setNer] = useState<NerBackend | null>(null);
  const [ai, setAi] = useState<'off' | 'loading' | 'ready' | 'error'>('off');
  const scroller = useRef<HTMLDivElement>(null);

  const pii = useMemo(
    () =>
      createAnonymizer({
        dictionary: terms.map((value) => ({ value, type: 'CUSTOM' as const })),
        ner: ner ?? false,
      }),
    [terms, ner],
  );

  async function toggleAi() {
    if (ai === 'ready' || ai === 'loading') {
      setNer(null);
      setAi('off');
      return;
    }
    setAi('loading');
    try {
      // onnxruntime-web is loaded from a CDN at RUNTIME (kept out of the bundle —
      // its wasm is 26 MB), and the 14.7 MB model + tokenizer come from this same
      // origin (no CORS). The `new Function` import is opaque to the bundler.
      const cdnImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
      const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
      const ort = await cdnImport(`${ORT}ort.webgpu.mjs`);
      ort.env.wasm.wasmPaths = ORT;
      const [vocab, labels] = await Promise.all([
        fetch('/models/vocab.json').then((r) => r.json()),
        fetch('/models/labels.json').then((r) => r.json()),
      ]);
      const { createRampartNer } = await import('local-pii');
      const backend = createRampartNer({ ort, model: '/models/rampart-q4.onnx', vocab, labels });
      await backend.load();
      setNer(backend);
      setAi('ready');
    } catch (e) {
      console.error('[local-pii] on-device model failed to load:', e);
      setAi('error');
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    const { redactedText, mapping, entities } = await pii.anonymize(text);
    const rehydrated = rehydrate(redactedText, mapping, { lenient: true });
    setTurns((t) => [...t, { original: text, redacted: redactedText, entities: [...entities], rehydrated }]);
    setInput('');
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: 9e9, behavior: 'smooth' }));
  }

  function addTerm() {
    const t = termInput.trim();
    if (t && !terms.includes(t)) setTerms((x) => [...x, t]);
    setTermInput('');
  }

  return (
    <Card className="not-prose my-6 h-[34rem] gap-0 overflow-hidden text-sm">
      {/* header */}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
        <ShieldCheck className="size-4 text-emerald-500" />
        <span className="font-semibold">Redaction chat</span>
        <Button
          onClick={toggleAi}
          disabled={ai === 'loading'}
          variant={ai === 'ready' ? 'secondary' : 'outline'}
          size="sm"
          title="Load the Rampart NER model in your browser to catch names & addresses live"
          className={cn(
            'ml-auto rounded-full',
            ai === 'ready' && 'border-purple-500/50 bg-purple-500/10 text-purple-600 dark:text-purple-400',
            ai === 'error' && 'border-red-500/50 text-red-600 dark:text-red-400',
          )}
        >
          {ai === 'loading' ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {ai === 'off' && 'On-device AI · 14.7 MB'}
          {ai === 'loading' && 'Loading model…'}
          {ai === 'ready' && 'AI on · names & addresses'}
          {ai === 'error' && 'Failed — retry'}
        </Button>
      </div>

      {/* dictionary */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 text-xs">
        <span className="text-muted-foreground">Also protect:</span>
        {terms.map((t) => (
          <Badge
            key={t}
            variant="outline"
            asChild
            className="cursor-pointer border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
          >
            <button onClick={() => setTerms((x) => x.filter((y) => y !== t))}>
              {t}
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          value={termInput}
          onChange={(e) => setTermInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTerm())}
          placeholder="Tomás, Amoxicilina…"
          className="h-7 w-40 text-xs"
        />
        <Button onClick={addTerm} size="icon" variant="outline" className="size-7" aria-label="add term">
          <Plus className="size-3" />
        </Button>
      </div>

      {/* conversation */}
      <div ref={scroller} className="flex-1 space-y-6 overflow-y-auto p-4">
        {turns.length === 0 && (
          <p className="mx-auto max-w-sm pt-10 text-center text-muted-foreground">
            Send a message. The assistant replies with <em>exactly what it received</em> — so the
            amber panel is everything a real model would ever see.
          </p>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-3">
            <div className="flex justify-end gap-2">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-primary-foreground">
                {turn.original}
              </div>
              <User className="mt-1 size-5 shrink-0 text-muted-foreground" />
            </div>

            <div className="ml-1 border-l-2 border-dashed border-amber-500/50 pl-3">
              <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                ↓ crosses the device boundary — only this is sent
              </div>
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 font-medium">
                <Tokens text={turn.redacted} />
              </div>
              {turn.entities.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {turn.entities.map((e, j) => (
                    <Badge key={j} variant="outline" className={SOURCE_STYLE[e.source]}>
                      {e.type}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <Bot className="mt-1 size-5 shrink-0 text-emerald-500" />
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm border bg-background px-3.5 py-2">
                <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  restored on device
                </div>
                {turn.rehydrated}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* composer */}
      <div className="flex items-end gap-2 border-t p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          rows={2}
          placeholder="Type a note with a name, email, phone…"
          className="min-h-10 flex-1 resize-none"
        />
        <Button onClick={send} size="icon" className="rounded-xl" aria-label="send">
          <ArrowUp />
        </Button>
      </div>

      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
        Turn on <strong>On-device AI</strong> (top-right) to catch names &amp; addresses live via the
        14.7 MB model. Medications and dates still need a dictionary entry — anything{' '}
        <strong>not</strong> highlighted was sent as-is. See{' '}
        <a href="/docs/limitations" className="underline">Limitations</a>.
      </p>
    </Card>
  );
}
