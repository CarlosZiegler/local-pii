const { withLocalPiiMetro } =
  require("local-pii/metro") as typeof import("local-pii/metro")

export const config = withLocalPiiMetro({ resolver: { assetExts: ["png"] } })
