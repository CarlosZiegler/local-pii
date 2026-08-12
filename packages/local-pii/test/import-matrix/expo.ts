import { getOrCreateDeviceSecret, rampart } from "local-pii/expo"

export const detection = rampart({ model: 1 })
export const deviceSecret = getOrCreateDeviceSecret
