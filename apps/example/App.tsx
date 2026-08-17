import { useMemo, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native"
import { StatusBar } from "expo-status-bar"
import {
  createAnonymizer,
  rehydrate,
  type AnonymizeResult,
  type Entity,
  type EntitySource,
} from "@local-pii/core"
import { callMockLlm } from "./src/llm"

const SAMPLE =
  "Ontem encontrei João Silva. Meu telefone é +49 151 12345678, " +
  "meu email é joao@example.com e moro na Müllerstraße 42 em Berlin."

const SOURCE_COLOR: Record<EntitySource, string> = {
  deterministic: "#2563eb",
  ner: "#7c3aed",
  dictionary: "#059669",
}

export default function App() {
  const scheme = useColorScheme()
  const t = scheme === "dark" ? dark : light

  const [text, setText] = useState(SAMPLE)
  const [useDetection, setUseDetection] = useState(false)
  const [privateMode, setPrivateMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AnonymizeResult | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const [restored, setRestored] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Recreate the anonymizer when the Detection model toggle changes.
  // Detection-off is deterministic-only. Detection-on is fail-closed (strict):
  // load/inference errors surface to the UI and skip the Generation call.
  // Do not set React state inside this memo.
  const detectionSetup = useMemo(() => {
    if (!useDetection) {
      return { mode: "deterministic" as const, anonymizer: createAnonymizer() }
    }
    try {
      // Lazily require the native ONNX runtime so deterministic-only mode keeps
      // working in Expo Go when Detection is off.
      const { rampart } =
        require("@local-pii/core/expo") as typeof import("@local-pii/core/expo")
      return {
        mode: "detection" as const,
        anonymizer: createAnonymizer({
          strict: true,
          detection: rampart({
            model: require("@local-pii/model-rampart/assets/rampart-q4.onnx"),
          }),
        }),
      }
    } catch (e) {
      return {
        mode: "setup-error" as const,
        message: (e as Error).message,
      }
    }
  }, [useDetection])

  async function run() {
    setBusy(true)
    setNote(null)
    setReply(null)
    setRestored(null)
    setResult(null)
    let res: AnonymizeResult
    try {
      if (detectionSetup.mode === "setup-error") {
        setNote(`Could not load the Detection model: ${detectionSetup.message}`)
        setBusy(false)
        return
      }
      res = await detectionSetup.anonymizer.anonymize(text)
      setResult(res)
    } catch (e) {
      setNote(`Detection failed: ${(e as Error).message}`)
      setBusy(false)
      return
    }

    if (privateMode) {
      setNote("Private mode: nothing was sent to any API.")
      setBusy(false)
      return
    }

    try {
      const answer = await callMockLlm(res.redactedText)
      setReply(answer)
      setRestored(rehydrate(answer, res.mapping, { lenient: true }))
    } catch (e) {
      setNote(`Generation failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.flex, { backgroundColor: t.bg }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: t.fg }]}>local-pii</Text>
        <Text style={[styles.subtitle, { color: t.muted }]}>
          Anonymize on device → send only placeholders → rehydrate the reply.
          The mapping never leaves your phone.
        </Text>

        <Text style={[styles.label, { color: t.muted }]}>Your note</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          style={[
            styles.input,
            { color: t.fg, borderColor: t.border, backgroundColor: t.card },
          ]}
          placeholderTextColor={t.muted}
        />

        <View style={styles.row}>
          <Toggle
            label="Detection model (Rampart)"
            value={useDetection}
            onValueChange={setUseDetection}
            t={t}
          />
          <Toggle
            label="Private mode"
            value={privateMode}
            onValueChange={setPrivateMode}
            t={t}
          />
        </View>

        <Pressable
          onPress={run}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t.accent, opacity: pressed || busy ? 0.7 : 1 },
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {privateMode ? "Anonymize (stay local)" : "Anonymize & send"}
            </Text>
          )}
        </Pressable>

        {note && <Text style={[styles.note, { color: t.warn }]}>{note}</Text>}

        {result && (
          <>
            <Section title="Redacted — this is all the API sees" t={t} mono>
              {result.redactedText}
            </Section>

            <Text style={[styles.label, { color: t.muted }]}>
              Detected ({result.entities.length})
            </Text>
            <View style={styles.chips}>
              {result.entities.map((e, i) => (
                <EntityChip key={i} entity={e} t={t} />
              ))}
            </View>

            {reply && (
              <Section title="AI reply (mock, sees placeholders only)" t={t}>
                {reply}
              </Section>
            )}
            {restored && (
              <Section title="Rehydrated on device — originals restored" t={t}>
                {restored}
              </Section>
            )}
          </>
        )}
      </ScrollView>
    </View>
  )
}

function Toggle(props: {
  label: string
  value: boolean
  onValueChange: (v: boolean) => void
  t: Theme
}) {
  return (
    <View style={styles.toggle}>
      <Switch value={props.value} onValueChange={props.onValueChange} />
      <Text style={[styles.toggleLabel, { color: props.t.fg }]}>
        {props.label}
      </Text>
    </View>
  )
}

function Section(props: {
  title: string
  t: Theme
  mono?: boolean
  children: string
}) {
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: props.t.card, borderColor: props.t.border },
      ]}
    >
      <Text style={[styles.sectionTitle, { color: props.t.muted }]}>
        {props.title}
      </Text>
      <Text
        style={[
          styles.sectionBody,
          props.mono && styles.mono,
          { color: props.t.fg },
        ]}
      >
        {props.children}
      </Text>
    </View>
  )
}

function EntityChip({ entity, t }: { entity: Entity; t: Theme }) {
  const color = SOURCE_COLOR[entity.source]
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipType, { color }]}>{entity.type}</Text>
      <Text style={[styles.chipText, { color: t.fg }]} numberOfLines={1}>
        {entity.text}
      </Text>
    </View>
  )
}

interface Theme {
  bg: string
  fg: string
  muted: string
  card: string
  border: string
  accent: string
  warn: string
}
const light: Theme = {
  bg: "#f7f7f8",
  fg: "#0b0b0f",
  muted: "#6b7280",
  card: "#ffffff",
  border: "#e5e7eb",
  accent: "#111827",
  warn: "#b45309",
}
const dark: Theme = {
  bg: "#0b0b0f",
  fg: "#f3f4f6",
  muted: "#9ca3af",
  card: "#16161c",
  border: "#26262e",
  accent: "#e5e7eb",
  warn: "#f59e0b",
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 20, paddingTop: 64, gap: 12 },
  title: { fontSize: 34, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { fontSize: 15, lineHeight: 21, marginBottom: 8 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginVertical: 4 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 8 },
  toggleLabel: { fontSize: 14, fontWeight: "500" },
  button: {
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  note: { fontSize: 14, fontWeight: "500" },
  section: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 6 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  sectionBody: { fontSize: 15, lineHeight: 22 },
  mono: { fontFamily: "Menlo", fontSize: 14 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
    maxWidth: "100%",
  },
  chipType: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  chipText: { fontSize: 13 },
})
