const { withLocalPiiMetro } =
  require("@local-pii/core/metro") as typeof import("@local-pii/core/metro")

export const config = withLocalPiiMetro({ resolver: { assetExts: ["png"] } })
