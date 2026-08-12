export interface LandingStrings {
  eyebrow: string
  h1: string
  sub: string
  docs: string
  chat: string
  runsOn: string
  membraneLocal: string
  membraneLeaves: string
  membraneModel: string
  pipeline: string
  features: { title: string; body: string }[]
  ctaTitle: string
  ctaBody: string
  ctaBtn: string
  license: string
}

const en: LandingStrings = {
  eyebrow: "local PII · Expo · browser · Node",
  h1: "The private mapping stays with you.",
  sub: "local-pii detects names, emails, phones and more inside the caller trust boundary — protected semantic content uses placeholders before the generation model, and the reply is restored locally. Opaque reasoning, metadata, and options stay caller-owned. The private mapping never leaves that boundary.",
  docs: "Read the docs",
  chat: "Try the live chat",
  runsOn: "runs on",
  membraneLocal: "inside your trust boundary",
  membraneLeaves: "leaves →",
  membraneModel: "protected content to the generation model",
  pipeline: `note ─▶ rules (email · phone · card · IBAN · SSN · IP)
     ─▶ your dictionary
     ─▶ Rampart Detection (names · addresses · IDs)
     ─▶ placeholders ─▶ Generation model
                          │
        reply ─▶ restore(reply) ─▶ restored text`,
  features: [
    {
      title: "Rampart Detection",
      body: "A 14.7 MB Rampart Detection model finds names, addresses and IDs in your app or the browser. Inference runs locally; in the browser the model artifacts may download on first use.",
    },
    {
      title: "Tool calls, solved",
      body: "Placeholders survive JSON and tool-call arguments. Your tools run with real values; adapters protect supported semantic content toward the generation provider.",
    },
    {
      title: "Any LLM",
      body: "Drop-in adapters for the Vercel AI SDK, OpenAI / Grok, and TanStack AI. Protect, call, restore — you barely change your code.",
    },
    {
      title: "Zero-dep core",
      body: "The detection + placeholder core has no runtime dependencies and runs in React Native, the browser and Node.",
    },
  ],
  ctaTitle: "See it protect, live.",
  ctaBody:
    "Type a note and watch personal information turn to placeholders in your browser — Detection runs locally.",
  ctaBtn: "Open the playground",
  license: "MIT · model CC BY 4.0",
}

const pt: LandingStrings = {
  eyebrow: "PII local · Expo · browser · Node",
  h1: "O mapeamento privado fica com você.",
  sub: "local-pii detecta nomes, emails, telefones e mais dentro do limite de confiança do chamador — o conteúdo semântico protegido usa placeholders antes do modelo de geração, e a resposta é restaurada localmente. Reasoning, metadados e opções opacos ficam sob responsabilidade do chamador. O mapeamento privado nunca sai desse limite.",
  docs: "Ler a documentação",
  chat: "Testar o chat ao vivo",
  runsOn: "roda em",
  membraneLocal: "dentro do seu limite de confiança",
  membraneLeaves: "sai →",
  membraneModel: "conteúdo protegido ao modelo de geração",
  pipeline: `nota ─▶ regras (email · telefone · cartão · IBAN · SSN · IP)
     ─▶ seu dicionário
     ─▶ Detecção Rampart (nomes · endereços · IDs)
     ─▶ placeholders ─▶ modelo de geração
                          │
        resposta ─▶ restaurar(resposta) ─▶ texto restaurado`,
  features: [
    {
      title: "Detecção Rampart",
      body: "Um modelo de Detecção Rampart de 14,7 MB encontra nomes, endereços e IDs no seu app ou no browser. A inferência roda localmente; no browser os artefatos do modelo podem ser baixados no primeiro uso.",
    },
    {
      title: "Tool calls, resolvido",
      body: "Placeholders sobrevivem a JSON e aos argumentos de tool call. Suas ferramentas rodam com valores reais; os adapters protegem o conteúdo semântico suportado em direção ao provedor de geração.",
    },
    {
      title: "Qualquer LLM",
      body: "Adapters plug-and-play para o Vercel AI SDK, OpenAI / Grok e TanStack AI. Proteja, chame, restaure — você quase não muda seu código.",
    },
    {
      title: "Core sem dependências",
      body: "O core de detecção + placeholders não tem dependências de runtime e roda em React Native, no browser e no Node.",
    },
  ],
  ctaTitle: "Veja proteger, ao vivo.",
  ctaBody:
    "Digite uma nota e veja informações pessoais virarem placeholders no seu browser — a Detecção roda localmente.",
  ctaBtn: "Abrir o playground",
  license: "MIT · modelo CC BY 4.0",
}

const de: LandingStrings = {
  eyebrow: "lokale PII · Expo · Browser · Node",
  h1: "Das private Mapping bleibt bei dir.",
  sub: "local-pii erkennt Namen, E-Mails, Telefonnummern und mehr innerhalb der Vertrauensgrenze des Aufrufers — geschützter semantischer Inhalt nutzt Platzhalter vor dem Generierungsmodell, und die Antwort wird lokal wiederhergestellt. Opakes Reasoning, Metadaten und Optionen bleiben in der Verantwortung des Aufrufers. Das private Mapping verlässt diese Grenze nie.",
  docs: "Zur Dokumentation",
  chat: "Live-Chat testen",
  runsOn: "läuft auf",
  membraneLocal: "innerhalb deiner Vertrauensgrenze",
  membraneLeaves: "verlässt →",
  membraneModel: "geschützter Inhalt zum Generierungsmodell",
  pipeline: `Notiz ─▶ Regeln (E-Mail · Telefon · Karte · IBAN · SSN · IP)
     ─▶ dein Wörterbuch
     ─▶ Rampart-Erkennung (Namen · Adressen · IDs)
     ─▶ Platzhalter ─▶ Generierungsmodell
                          │
        Antwort ─▶ wiederherstellen(Antwort) ─▶ wiederhergestellter Text`,
  features: [
    {
      title: "Rampart-Erkennung",
      body: "Ein 14,7 MB großes Rampart-Erkennungsmodell findet Namen, Adressen und IDs in deiner App oder im Browser. Die Inferenz läuft lokal; im Browser können die Modell-Artefakte beim ersten Gebrauch heruntergeladen werden.",
    },
    {
      title: "Tool Calls, gelöst",
      body: "Platzhalter überstehen JSON und Tool-Call-Argumente. Deine Tools laufen mit echten Werten; Adapter schützen unterstützten semantischen Inhalt Richtung Generierungsanbieter.",
    },
    {
      title: "Jedes LLM",
      body: "Fertige Adapter für das Vercel AI SDK, OpenAI / Grok und TanStack AI. Schützen, aufrufen, wiederherstellen — kaum Code-Änderungen.",
    },
    {
      title: "Core ohne Dependencies",
      body: "Der Erkennungs- und Platzhalter-Core hat keine Runtime-Dependencies und läuft in React Native, im Browser und in Node.",
    },
  ],
  ctaTitle: "Sieh den Schutz, live.",
  ctaBody:
    "Tippe eine Notiz und sieh persönliche Daten im Browser zu Platzhaltern werden — die Erkennung läuft lokal.",
  ctaBtn: "Playground öffnen",
  license: "MIT · Modell CC BY 4.0",
}

const STRINGS: Record<string, LandingStrings> = { en, pt, de }

export function getLanding(lang: string): LandingStrings {
  return STRINGS[lang] ?? en
}
