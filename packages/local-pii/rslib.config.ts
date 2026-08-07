import { defineConfig } from "@rslib/core"

// Library build powered by Rspack (Rslib). Emits ESM + CJS + type
// declarations. Peer/optional native deps (onnxruntime-react-native, expo*)
// are auto-externalized, so the bundle stays pure and dependency-free.
export default defineConfig({
  source: {
    entry: {
      index: "./src/index.ts",
      expo: "./src/expo.ts",
      metro: "./src/metro.ts",
      web: "./src/web.ts",
      openai: "./src/openai.ts",
      "ai-sdk": "./src/ai-sdk.ts",
    },
  },
  lib: [
    { format: "esm", dts: { bundle: true } },
    { format: "cjs" },
  ],
  output: {
    target: "web",
    sourceMap: true,
    cleanDistPath: true,
  },
})
