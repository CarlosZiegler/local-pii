import { getRandomBytes } from "expo-crypto"
import { getItemAsync, setItemAsync } from "expo-secure-store"
import { toHex } from "./crypto/sha256"

const DEFAULT_KEY = "local-pii.device-secret"

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Get (or lazily create) a random 256-bit device secret, persisted in the
 * platform keystore via `expo-secure-store`. Pass the result to
 * `hashed({ secret })` for stable, non-reversible cross-session placeholders.
 * The secret never leaves the device.
 */
export async function getOrCreateDeviceSecret(
  key: string = DEFAULT_KEY,
): Promise<Uint8Array> {
  const stored = await getItemAsync(key)
  if (stored) return fromHex(stored)
  const secret = getRandomBytes(32)
  await setItemAsync(key, toHex(secret))
  return secret
}
