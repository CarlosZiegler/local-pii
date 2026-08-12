/**
 * local-pii — on-device PII anonymization for Expo / React Native.
 *
 * This entry point is pure TypeScript and imports NO native modules, so it
 * works in React Native, Node and the browser. To add the Rampart NER model
 * on device, import `rampart()` from the `local-pii/expo` subpath.
 */

export { createAnonymizer } from "./anonymizer"
export type {
  Anonymizer,
  AnonymizerOptions,
  AnonymizerStatus,
} from "./anonymizer"

export { rehydrate, createStreamingRehydrator } from "./rehydrate"
export type { StreamingRehydrator } from "./rehydrate"
export { rehydrateJson, rehydrateToolArgs } from "./json"
export type { RehydratedToolArgs } from "./json"
export type { PiiSession } from "./session"

// Detectors (each individually composable)
export { builtinDetectors, defaultDetectors } from "./detectors/builtin"
export { createDictionaryDetector } from "./detectors/dictionary"
export { creditCardDetector } from "./detectors/creditCard"
export { emailDetector } from "./detectors/email"
export { ibanDetector } from "./detectors/iban"
export { ipDetector } from "./detectors/ip"
export { phoneDetector } from "./detectors/phone"
export { ssnDetector } from "./detectors/ssn"
export { urlDetector } from "./detectors/url"

// Placeholder strategies
export { hashed, sequential, token } from "./placeholder/strategies"

// NER — the noop default plus the runtime-agnostic Rampart core (inject an
// `onnxruntime-common`-compatible module; `local-pii/expo` wires RN for you).
export { noopNer } from "./ner/backend"
export { createRampartNer } from "./ner/rampart"
export type {
  OrtModule,
  OrtSession,
  OrtTensor,
  RampartNerConfig,
} from "./ner/rampart"

// Advanced: the WordPiece tokenizer with original-text offsets
export { createBertTokenizer } from "./tokenizer/wordpiece"
export type { BertTokenizer, EncodedToken } from "./tokenizer/wordpiece"

// Advanced: expose the merge primitive for custom pipelines
export { mergeEntities } from "./pipeline/merge"

// Domain types
export type {
  AnonymizeResult,
  Detector,
  DetectionModel,
  DictionaryEntry,
  Entity,
  EntitySource,
  Mapping,
  NerBackend,
  PiiType,
  PlaceholderStrategy,
  RehydrateOptions,
  Span,
} from "./types"
