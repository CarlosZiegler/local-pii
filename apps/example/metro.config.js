// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config")
const { withLocalPiiMetro } = require("local-pii/metro")
const path = require("path")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "../..")

const config = getDefaultConfig(projectRoot)

// Monorepo: watch the whole workspace and resolve hoisted dependencies.
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]

// Let Metro treat the Rampart .onnx model as a bundled asset.
module.exports = withLocalPiiMetro(config)
