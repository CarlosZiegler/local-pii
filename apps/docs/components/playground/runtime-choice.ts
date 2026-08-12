import type { RuntimeOption } from "./model/types"

export function runtimeChoiceAriaLabel(option: RuntimeOption): string {
  const action =
    option.availability === "unavailable"
      ? "Unavailable"
      : option.availability === "ready"
        ? "Use"
        : "Activate"
  return `${action} ${option.disclosure.label}`
}
