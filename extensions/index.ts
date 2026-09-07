// pi-codegraphcontext extension entry.
// Registered against the Pi extension API; the CGC lifecycle gate, config
// loading, and CLI-gap tools land via the OpenSpec changes (openspec/changes/add-cgc-*).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function piCodegraphcontext(pi: ExtensionAPI): void {
  // Extension hooks and tools are registered by the add-cgc-* changes.
  // The entry stays fail-open: it never throws during load or registration.
  void pi
}
