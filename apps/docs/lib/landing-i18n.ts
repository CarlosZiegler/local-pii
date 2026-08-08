export interface LandingStrings {
  eyebrow: string;
  h1: string;
  sub: string;
  docs: string;
  chat: string;
  runsOn: string;
  features: { title: string; body: string }[];
  ctaTitle: string;
  ctaBody: string;
  ctaBtn: string;
  license: string;
}

const en: LandingStrings = {
  eyebrow: 'on-device PII · Expo · browser · Node',
  h1: 'The PII never leaves the device.',
  sub: 'local-pii redacts names, emails, phones and more on device — only placeholders reach your LLM, and the reply is rehydrated locally. The mapping never leaves.',
  docs: 'Read the docs',
  chat: 'Try the live chat',
  runsOn: 'runs on',
  features: [
    { title: 'On-device model', body: 'A 14.7 MB Rampart model runs in your app or the browser — names, addresses and IDs, fully offline.' },
    { title: 'Tool calls, solved', body: 'Placeholders survive JSON and tool-call arguments. Your tools run with real values; the provider never sees them.' },
    { title: 'Any LLM', body: 'Drop-in adapters for the Vercel AI SDK and OpenAI / Grok. Anonymize, call, rehydrate — you barely change your code.' },
    { title: 'Zero-dep core', body: 'The detection + placeholder core has no runtime dependencies and runs in React Native, the browser and Node.' },
  ],
  ctaTitle: 'See it redact, live.',
  ctaBody: 'Type a note and watch PII turn to placeholders in your browser — the model runs on device.',
  ctaBtn: 'Open the playground',
  license: 'MIT · model CC BY 4.0',
};

const pt: LandingStrings = {
  eyebrow: 'PII no dispositivo · Expo · browser · Node',
  h1: 'O PII nunca sai do dispositivo.',
  sub: 'local-pii anonimiza nomes, emails, telefones e mais no dispositivo — só placeholders chegam ao seu LLM, e a resposta é reidratada localmente. O mapeamento nunca sai.',
  docs: 'Ler a documentação',
  chat: 'Testar o chat ao vivo',
  runsOn: 'roda em',
  features: [
    { title: 'Modelo no dispositivo', body: 'Um modelo Rampart de 14,7 MB roda no seu app ou no browser — nomes, endereços e IDs, totalmente offline.' },
    { title: 'Tool calls, resolvido', body: 'Placeholders sobrevivem a JSON e aos argumentos de tool call. Suas ferramentas rodam com valores reais; o provedor nunca os vê.' },
    { title: 'Qualquer LLM', body: 'Adapters plug-and-play para o Vercel AI SDK e OpenAI / Grok. Anonimize, chame, reidrate — você quase não muda seu código.' },
    { title: 'Core sem dependências', body: 'O core de detecção + placeholders não tem dependências de runtime e roda em React Native, no browser e no Node.' },
  ],
  ctaTitle: 'Veja anonimizar, ao vivo.',
  ctaBody: 'Digite uma nota e veja o PII virar placeholders no seu browser — o modelo roda no dispositivo.',
  ctaBtn: 'Abrir o playground',
  license: 'MIT · modelo CC BY 4.0',
};

const de: LandingStrings = {
  eyebrow: 'PII auf dem Gerät · Expo · Browser · Node',
  h1: 'Die PII verlässt das Gerät nie.',
  sub: 'local-pii anonymisiert Namen, E-Mails, Telefonnummern und mehr auf dem Gerät — nur Platzhalter erreichen dein LLM, und die Antwort wird lokal rehydriert. Das Mapping verlässt das Gerät nie.',
  docs: 'Zur Dokumentation',
  chat: 'Live-Chat testen',
  runsOn: 'läuft auf',
  features: [
    { title: 'Modell auf dem Gerät', body: 'Ein 14,7 MB großes Rampart-Modell läuft in deiner App oder im Browser — Namen, Adressen und IDs, komplett offline.' },
    { title: 'Tool Calls, gelöst', body: 'Platzhalter überstehen JSON und Tool-Call-Argumente. Deine Tools laufen mit echten Werten; der Anbieter sieht sie nie.' },
    { title: 'Jedes LLM', body: 'Fertige Adapter für das Vercel AI SDK und OpenAI / Grok. Anonymisieren, aufrufen, rehydrieren — kaum Code-Änderungen.' },
    { title: 'Core ohne Dependencies', body: 'Der Erkennungs- und Platzhalter-Core hat keine Runtime-Dependencies und läuft in React Native, im Browser und in Node.' },
  ],
  ctaTitle: 'Sieh die Anonymisierung, live.',
  ctaBody: 'Tippe eine Notiz und sieh PII im Browser zu Platzhaltern werden — das Modell läuft auf dem Gerät.',
  ctaBtn: 'Playground öffnen',
  license: 'MIT · Modell CC BY 4.0',
};

const STRINGS: Record<string, LandingStrings> = { en, pt, de };

export function getLanding(lang: string): LandingStrings {
  return STRINGS[lang] ?? en;
}
