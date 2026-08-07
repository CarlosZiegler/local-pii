'use client';

import { useMemo, useState } from 'react';
import { createAnonymizer, rehydrate, type Entity } from 'local-pii';
import { ArrowUp, ShieldCheck, Plus, X, Bot, User } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Exchange {
  original: string;
  redacted: string;
  entities: Entity[];
  rehydrated: string;
}

const SAMPLE =
  'Resumo do meu filho Tomás: consulta com a Dra. Beatriz, email ana.souza@gmail.com, ' +
  'tel +55 11 91234-5678, tomando Amoxicilina para dor de ouvido.';

const PLACEHOLDER = /\[[A-Z0-9_]+_\d+\]|PII[0-9A-HJKMNP-TV-Z]+/g;

const SOURCE_STYLE: Record<Entity['source'], string> = {
  deterministic: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
  ner: 'border-purple-500/40 text-purple-600 dark:text-purple-400',
  dictionary: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
};

function Highlighted({ text }: { text: string }) {
  const parts = text.split(PLACEHOLDER);
  const tokens = text.match(PLACEHOLDER) ?? [];
  return (
    <span>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {tokens[i] && (
            <mark className="rounded bg-amber-500/15 px-1 font-mono text-[0.85em] text-amber-700 dark:text-amber-400">
              {tokens[i]}
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
  const [log, setLog] = useState<Exchange[]>([]);

  const pii = useMemo(
    () =>
      createAnonymizer({
        dictionary: terms.map((value) => ({ value, type: 'CUSTOM' as const })),
      }),
    [terms],
  );

  async function send() {
    const text = input.trim();
    if (!text) return;
    const { redactedText, mapping, entities } = await pii.anonymize(text);
    // The "assistant" replies with exactly what it received (the redacted text),
    // then we rehydrate it on device — proving nothing leaked and it round-trips.
    const rehydrated = rehydrate(redactedText, mapping, { lenient: true });
    setLog((l) => [...l, { original: text, redacted: redactedText, entities: [...entities], rehydrated }]);
    setInput('');
  }

  function addTerm() {
    const t = termInput.trim();
    if (t && !terms.includes(t)) setTerms((x) => [...x, t]);
    setTermInput('');
  }

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border bg-fd-card text-fd-card-foreground shadow-sm">
      {/* header */}
      <div className="flex items-center gap-2 border-b bg-fd-muted/40 px-4 py-3">
        <ShieldCheck className="size-4 text-emerald-500" />
        <span className="text-sm font-semibold">Redaction playground</span>
        <span className="ml-auto text-xs text-fd-muted-foreground">runs on device — nothing is sent</span>
      </div>

      {/* dictionary editor */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="text-xs font-medium text-fd-muted-foreground">Protect extra terms:</span>
        {terms.map((t) => (
          <button
            key={t}
            onClick={() => setTerms((x) => x.filter((y) => y !== t))}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 px-2 py-0.5 text-xs text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
          >
            {t}
            <X className="size-3" />
          </button>
        ))}
        <span className="inline-flex items-center gap-1">
          <input
            value={termInput}
            onChange={(e) => setTermInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTerm())}
            placeholder="e.g. Tomás, Amoxicilina"
            className="w-40 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:border-fd-primary"
          />
          <button onClick={addTerm} className="rounded-md border p-1 hover:bg-fd-muted" aria-label="add term">
            <Plus className="size-3" />
          </button>
        </span>
      </div>

      {/* conversation */}
      <div className="max-h-[26rem] space-y-4 overflow-y-auto p-4">
        {log.length === 0 && (
          <p className="py-8 text-center text-sm text-fd-muted-foreground">
            Send a message. The “assistant” replies with exactly what it received —
            so the middle panel is everything a real LLM would ever see.
          </p>
        )}
        {log.map((ex, i) => (
          <div key={i} className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <User className="mt-0.5 size-4 shrink-0 text-fd-muted-foreground" />
              <div className="rounded-lg border px-3 py-2">{ex.original}</div>
            </div>

            <div className="ml-6 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <div className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                ↑ sent to the LLM (only this leaves the device)
              </div>
              <Highlighted text={ex.redacted} />
              {ex.entities.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {ex.entities.map((e, j) => (
                    <span
                      key={j}
                      className={cn('rounded-full border px-1.5 py-0.5 text-[0.65rem] font-medium', SOURCE_STYLE[e.source])}
                    >
                      {e.type}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-start gap-2">
              <Bot className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                <div className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  ↓ reply, rehydrated on device
                </div>
                {ex.rehydrated}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* input */}
      <div className="flex items-end gap-2 border-t p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          rows={2}
          placeholder="Type a note with a name, email, phone…"
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-fd-primary"
        />
        <button
          onClick={send}
          className="inline-flex size-9 items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground transition hover:opacity-90"
          aria-label="send"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>

      <p className="border-t px-4 py-2 text-xs text-fd-muted-foreground">
        Deterministic detectors only. Anything <strong>not</strong> highlighted was sent as-is —
        names, medications and dates need the{' '}
        <a href="/docs/expo" className="underline">
          on-device model
        </a>{' '}
        or a dictionary entry. That gap is the point: see{' '}
        <a href="/docs/limitations" className="underline">
          Limitations
        </a>
        .
      </p>
    </div>
  );
}
