// Shell quoting. (v0.1's on-box leases are gone: the daemon owns its boxes; killing a slot's leftovers lives in
// src/wrap/cib-wrap.sh.)

/** Single-quote a string for bash. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
