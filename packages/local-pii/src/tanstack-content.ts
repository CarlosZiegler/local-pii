import type {
  ContentPart,
  MessagePart,
  ModelMessage,
  UIMessage,
} from "@tanstack/ai/client"
import type { PiiSession } from "./session"
import {
  appendPath,
  capture,
  captureArray,
  cloneRecord,
  descriptor,
  optional,
  required,
  type Captured,
} from "./tanstack-capture"
import {
  fail,
  UnsupportedTanStackSemanticContentError,
  type Path,
} from "./tanstack-errors"
import {
  captureJson,
  freeform,
  lenientJson,
  partialJson,
  protectPreparedJson,
  protectText,
  renderFreeform,
  strictJson,
  type Freeform,
  type PreparedJson,
  type PreparedToolArguments,
} from "./tanstack-json"
import { assertTanStackArrayPrototypeStable } from "./tanstack-prototype"
import {
  TRUSTED,
  freezeDetachedRecord,
  safeArray,
  trustedApply,
  trustedMapSet,
} from "./tanstack-trusted"

export { UnsupportedTanStackSemanticContentError }
export { assertTanStackArrayPrototypeStable }

type TanStackMessages = Array<UIMessage> | Array<ModelMessage>
type Family = "ui" | "model"
type Policy = "text" | "opaque" | "structured" | "tool-call" | "tool-result"
type ModelPartType = ContentPart["type"]
type UiPartType = MessagePart["type"]

/** Exhaustive pinned protocol policy. Additions to either public union fail here. */
const PART_POLICY = {
  model: {
    text: "text",
    image: "opaque",
    audio: "opaque",
    video: "opaque",
    document: "opaque",
  },
  ui: {
    text: "text",
    image: "opaque",
    audio: "opaque",
    video: "opaque",
    document: "opaque",
    "tool-call": "tool-call",
    "tool-result": "tool-result",
    thinking: "opaque",
    "structured-output": "structured",
    "ui-resource": "opaque",
  },
} as const satisfies {
  model: Record<ModelPartType, Policy>
  ui: Record<UiPartType, Policy>
}

type PreparedPart =
  | { readonly kind: "opaque"; readonly template: Captured }
  | {
      readonly kind: "text"
      readonly template: Captured
      readonly text: string
    }
  | {
      readonly kind: "freeform-text"
      readonly template: Captured
      readonly value: Freeform
    }
  | {
      readonly kind: "structured-fallback"
      readonly template: Captured
      readonly json?: PreparedJson
      readonly data?: PreparedJson
      readonly partial?: PreparedJson
      readonly errorMessage?: string
    }
  | {
      readonly kind: "tool-call"
      readonly template: Captured
      readonly args: PreparedToolArguments
      readonly input?: PreparedJson
      readonly output?: PreparedJson
    }
  | {
      readonly kind: "tool-result"
      readonly template: Captured
      readonly content: Freeform | PreparedPartList
      readonly error?: string
    }

interface PreparedPartList {
  readonly template: Captured
  readonly items: readonly PreparedPart[]
}

function policy(family: Family, type: unknown): Policy | undefined {
  if (typeof type !== "string") return undefined
  const table = PART_POLICY[family]
  return trustedApply(TRUSTED.hasOwnProperty, table, [type])
    ? table[type as keyof typeof table]
    : undefined
}

function prepareParts(
  value: unknown,
  path: Path,
  family: Family,
  jsonText: boolean
): PreparedPartList {
  const captured = captureArray(value, path)
  const items = safeArray<PreparedPart>()
  for (let index = 0; index < captured.values.length; index += 1) {
    items[index] = freezeDetachedRecord(
      preparePart(
        captured.values[index],
        appendPath(path, index),
        family,
        jsonText
      )
    )
  }
  return freezeDetachedRecord({
    template: captured.record,
    items: TRUSTED.objectFreeze(items),
  })
}

function preparePart(
  value: unknown,
  path: Path,
  family: Family,
  jsonText: boolean
): PreparedPart {
  const template = capture(value, path)
  const type = required(template, "type", appendPath(path, "type"))
  const kind = policy(family, type)
  if (!kind) return fail(path, "<unsupported>")
  if (kind === "opaque") return { kind, template }
  if (kind === "text") {
    const content = required(template, "content", appendPath(path, "content"))
    if (typeof content !== "string")
      return fail(appendPath(path, "content"), "<invalid>")
    return jsonText
      ? {
          kind: "freeform-text",
          template,
          value: freeform(content, appendPath(path, "content")),
        }
      : { kind, template, text: content }
  }
  if (kind === "structured") {
    const status = required(template, "status", appendPath(path, "status"))
    if (status !== "streaming" && status !== "complete" && status !== "error")
      return fail(appendPath(path, "status"), "<invalid>")
    const raw = required(template, "raw", appendPath(path, "raw"))
    if (typeof raw !== "string")
      return fail(appendPath(path, "raw"), "<invalid>")
    const data = optional(template, "data")
    const partial = optional(template, "partial")
    const errorMessage = optional(template, "errorMessage")
    if (
      errorMessage.kind === "data" &&
      errorMessage.value !== undefined &&
      typeof errorMessage.value !== "string"
    )
      return fail(appendPath(path, "errorMessage"), "<invalid>")
    const preparedData =
      data.kind === "data" && data.value !== undefined
        ? (captureJson(data.value, appendPath(path, "data")) as PreparedJson)
        : undefined
    const preparedPartial =
      partial.kind === "data" && partial.value !== undefined
        ? (captureJson(
            partial.value,
            appendPath(path, "partial")
          ) as PreparedJson)
        : undefined
    const json =
      status === "complete"
        ? raw === ""
          ? preparedData !== undefined
            ? preparedData
            : captureJson(
                required(template, "data", appendPath(path, "data")),
                appendPath(path, "data")
              )
          : strictJson(raw, appendPath(path, "raw"))
        : lenientJson(raw, appendPath(path, "raw"))
    return freezeDetachedRecord({
      kind: "structured-fallback",
      template,
      ...(json !== undefined ? { json } : {}),
      ...(preparedData !== undefined ? { data: preparedData } : {}),
      ...(preparedPartial !== undefined ? { partial: preparedPartial } : {}),
      ...(errorMessage.kind === "data" && typeof errorMessage.value === "string"
        ? { errorMessage: errorMessage.value }
        : {}),
    })
  }
  if (kind === "tool-call") {
    const argumentsPath = appendPath(path, "arguments")
    const argumentsValue = required(template, "arguments", argumentsPath)
    if (typeof argumentsValue !== "string")
      return fail(argumentsPath, "<invalid>")
    const state = required(template, "state", appendPath(path, "state"))
    const validState =
      state === "awaiting-input" ||
      state === "input-streaming" ||
      state === "input-complete" ||
      state === "approval-requested" ||
      state === "approval-responded" ||
      state === "complete" ||
      state === "error"
    if (!validState) return fail(appendPath(path, "state"), "<invalid>")
    const input = optional(template, "input")
    const output = optional(template, "output")
    const preparedInput =
      input.kind === "data" && input.value !== undefined
        ? captureJson(input.value, appendPath(path, "input"))
        : undefined
    const preparedOutput =
      output.kind === "data" && output.value !== undefined
        ? captureJson(output.value, appendPath(path, "output"))
        : undefined
    const partialState =
      state === "awaiting-input" ||
      state === "input-streaming" ||
      state === "error"
    return {
      kind,
      template,
      args: partialState
        ? partialJson(argumentsValue, argumentsPath)
        : { kind: "json", value: strictJson(argumentsValue, argumentsPath) },
      ...(preparedInput !== undefined ? { input: preparedInput } : {}),
      ...(preparedOutput !== undefined ? { output: preparedOutput } : {}),
    }
  }
  const content = required(template, "content", appendPath(path, "content"))
  const preparedContent =
    typeof content === "string"
      ? freeform(content, appendPath(path, "content"))
      : TRUSTED.arrayIsArray(content)
        ? prepareParts(content, appendPath(path, "content"), "model", true)
        : fail(appendPath(path, "content"), "<invalid>")
  const error = optional(template, "error")
  if (
    error.kind === "data" &&
    error.value !== undefined &&
    typeof error.value !== "string"
  )
    return fail(appendPath(path, "error"), "<invalid>")
  return {
    kind,
    template,
    content: preparedContent,
    ...(error.kind === "data" && typeof error.value === "string"
      ? { error: error.value }
      : {}),
  }
}

interface PreparedToolCall {
  readonly template: Captured
  readonly functionTemplate: Captured
  readonly args: PreparedJson
}

interface PreparedToolCalls {
  readonly template: Captured
  readonly items: readonly PreparedToolCall[]
}

function prepareToolCalls(value: unknown, path: Path): PreparedToolCalls {
  const captured = captureArray(value, path)
  const items = safeArray<PreparedToolCall>()
  for (let index = 0; index < captured.values.length; index += 1) {
    const itemPath = appendPath(path, index)
    const functionPath = appendPath(itemPath, "function")
    const argumentsPath = appendPath(functionPath, "arguments")
    const template = capture(captured.values[index], itemPath)
    const functionValue = required(template, "function", functionPath)
    const functionTemplate = capture(functionValue, functionPath)
    const args = required(functionTemplate, "arguments", argumentsPath)
    if (typeof args !== "string") return fail(argumentsPath, "<invalid>")
    items[index] = freezeDetachedRecord({
      template,
      functionTemplate,
      args: strictJson(args, argumentsPath),
    })
  }
  return freezeDetachedRecord({
    template: captured.record,
    items: TRUSTED.objectFreeze(items),
  })
}

type PreparedMessage =
  | {
      readonly family: "ui"
      readonly template: Captured
      readonly parts: PreparedPartList
    }
  | {
      readonly family: "model"
      readonly template: Captured
      readonly content: string | null | Freeform | PreparedPartList
      readonly toolCalls?: PreparedToolCalls
    }

interface PreparedMessages {
  readonly template: Captured
  readonly items: readonly PreparedMessage[]
}

function shape(record: Captured): { ui: boolean; model: boolean } {
  const id = descriptor(record, "id")
  const parts = descriptor(record, "parts")
  const content = descriptor(record, "content")
  return { ui: !!id && !!parts, model: !!content }
}

function classify(records: readonly Captured[]): Family {
  let candidate: Family | undefined
  let ambiguousIndex: number | undefined
  for (let index = 0; index < records.length; index += 1) {
    const current = shape(records[index]!)
    const family =
      current.ui === current.model ? undefined : current.ui ? "ui" : "model"
    if (!family) {
      ambiguousIndex ??= index
      continue
    }
    if (candidate && candidate !== family)
      return fail(appendPath([], index), "<unsupported>")
    candidate = family
  }
  if (ambiguousIndex !== undefined)
    return fail(appendPath([], ambiguousIndex), "<ambiguous>")
  if (candidate) return candidate
  return fail([], "<unsupported>")
}

function prepareMessage(
  record: Captured,
  index: number,
  family: Family
): PreparedMessage {
  const messagePath = appendPath([], index)
  const rolePath = appendPath(messagePath, "role")
  const role = required(record, "role", rolePath)
  if (family === "ui") {
    const idPath = appendPath(messagePath, "id")
    const id = required(record, "id", idPath)
    if (typeof id !== "string") return fail(idPath, "<invalid>")
    if (role !== "system" && role !== "user" && role !== "assistant")
      return fail(rolePath, "<invalid>")
    return {
      family,
      template: record,
      parts: prepareParts(
        required(record, "parts", appendPath(messagePath, "parts")),
        appendPath(messagePath, "parts"),
        "ui",
        false
      ),
    }
  }
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return fail(rolePath, "<invalid>")
  const contentPath = appendPath(messagePath, "content")
  const content = required(record, "content", contentPath)
  const prepared =
    typeof content === "string"
      ? role === "tool"
        ? freeform(content, contentPath)
        : content
      : content === null
        ? null
        : TRUSTED.arrayIsArray(content)
          ? prepareParts(content, contentPath, "model", role === "tool")
          : fail(contentPath, "<invalid>")
  const toolCalls = optional(record, "toolCalls")
  return {
    family,
    template: record,
    content: prepared,
    ...(toolCalls.kind === "data" && toolCalls.value !== undefined
      ? {
          toolCalls: prepareToolCalls(
            toolCalls.value,
            appendPath(messagePath, "toolCalls")
          ),
        }
      : {}),
  }
}

/** The sole caller-object phase: captures and compiles the complete graph synchronously. */
function captureMessages(messages: TanStackMessages): PreparedMessages {
  const root = captureArray(messages, [])
  const records = safeArray<Captured>()
  for (let index = 0; index < root.values.length; index += 1)
    records[index] = capture(root.values[index], appendPath([], index))
  if (records.length === 0)
    return freezeDetachedRecord({
      template: root.record,
      items: TRUSTED.objectFreeze(safeArray<PreparedMessage>()),
    })
  const family = classify(records)
  const items = safeArray<PreparedMessage>()
  for (let index = 0; index < records.length; index += 1)
    items[index] = freezeDetachedRecord(
      prepareMessage(records[index]!, index, family)
    )
  return freezeDetachedRecord({
    template: root.record,
    items: TRUSTED.objectFreeze(items),
  })
}

function isFreeform(value: Freeform | PreparedPartList): value is Freeform {
  const kind = TRUSTED.objectGetOwnPropertyDescriptor(value, "kind")
  return (
    !!kind &&
    "value" in kind &&
    (kind.value === "text" || kind.value === "json")
  )
}

async function renderParts(
  session: PiiSession,
  prepared: PreparedPartList,
  path: Path
): Promise<object> {
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < prepared.items.length; index += 1)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
      await renderPart(session, prepared.items[index]!, appendPath(path, index))
    )
  return cloneRecord(prepared.template, overrides, path)
}

async function renderPart(
  session: PiiSession,
  prepared: PreparedPart,
  path: Path
): Promise<object> {
  if (prepared.kind === "opaque")
    return cloneRecord(
      prepared.template,
      new TRUSTED.mapConstructor<PropertyKey, unknown>(),
      path
    )
  if (prepared.kind === "text") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "content",
      await protectText(session, prepared.text)
    )
    return cloneRecord(prepared.template, overrides, path)
  }
  if (prepared.kind === "freeform-text") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "content",
      await renderFreeform(session, prepared.value)
    )
    return cloneRecord(prepared.template, overrides, path)
  }
  if (prepared.kind === "structured-fallback") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "raw",
      prepared.json === undefined
        ? ""
        : TRUSTED.jsonStringify(
            await protectPreparedJson(session, prepared.json)
          )
    )
    if (prepared.data !== undefined)
      trustedMapSet(
        overrides,
        "data",
        await protectPreparedJson(session, prepared.data)
      )
    if (prepared.partial !== undefined)
      trustedMapSet(
        overrides,
        "partial",
        await protectPreparedJson(session, prepared.partial)
      )
    if (prepared.errorMessage !== undefined)
      trustedMapSet(
        overrides,
        "errorMessage",
        await protectText(session, prepared.errorMessage)
      )
    return cloneRecord(prepared.template, overrides, path)
  }
  if (prepared.kind === "tool-call") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "arguments",
      prepared.args.kind === "partial"
        ? ""
        : TRUSTED.jsonStringify(
            await protectPreparedJson(session, prepared.args.value)
          )
    )
    if (prepared.input !== undefined)
      trustedMapSet(
        overrides,
        "input",
        await protectPreparedJson(session, prepared.input)
      )
    if (prepared.output !== undefined)
      trustedMapSet(
        overrides,
        "output",
        await protectPreparedJson(session, prepared.output)
      )
    return cloneRecord(prepared.template, overrides, path)
  }
  const content = isFreeform(prepared.content)
    ? await renderFreeform(session, prepared.content)
    : await renderParts(session, prepared.content, appendPath(path, "content"))
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  trustedMapSet(overrides, "content", content)
  if (prepared.error !== undefined)
    trustedMapSet(
      overrides,
      "error",
      await protectText(session, prepared.error)
    )
  return cloneRecord(prepared.template, overrides, path)
}

async function renderToolCalls(
  session: PiiSession,
  prepared: PreparedToolCalls,
  path: Path
): Promise<object> {
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < prepared.items.length; index += 1) {
    const item = prepared.items[index]!
    const functionOverrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      functionOverrides,
      "arguments",
      TRUSTED.jsonStringify(await protectPreparedJson(session, item.args))
    )
    const functionValue = cloneRecord(
      item.functionTemplate,
      functionOverrides,
      appendPath(path, index, "function")
    )
    const itemOverrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(itemOverrides, "function", functionValue)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
      cloneRecord(item.template, itemOverrides, appendPath(path, index))
    )
  }
  return cloneRecord(prepared.template, overrides, path)
}

async function renderMessage(
  session: PiiSession,
  prepared: PreparedMessage,
  index: number
): Promise<object> {
  if (prepared.family === "ui") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "parts",
      await renderParts(session, prepared.parts, appendPath([], index, "parts"))
    )
    return cloneRecord(prepared.template, overrides, appendPath([], index))
  }
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  if (typeof prepared.content === "string")
    trustedMapSet(
      overrides,
      "content",
      await protectText(session, prepared.content)
    )
  else if (prepared.content === null) trustedMapSet(overrides, "content", null)
  else if (isFreeform(prepared.content))
    trustedMapSet(
      overrides,
      "content",
      await renderFreeform(session, prepared.content)
    )
  else
    trustedMapSet(
      overrides,
      "content",
      await renderParts(
        session,
        prepared.content,
        appendPath([], index, "content")
      )
    )
  if (prepared.toolCalls)
    trustedMapSet(
      overrides,
      "toolCalls",
      await renderToolCalls(
        session,
        prepared.toolCalls,
        appendPath([], index, "toolCalls")
      )
    )
  return cloneRecord(prepared.template, overrides, appendPath([], index))
}

export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  assertTanStackArrayPrototypeStable()
  const prepared = captureMessages(messages)
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < prepared.items.length; index += 1)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
      await renderMessage(session, prepared.items[index]!, index)
    )
  return cloneRecord(prepared.template, overrides, []) as TanStackMessages
}
