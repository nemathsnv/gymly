/* Parts of a profile no MCP tool reads, whichever way the profile reaches this process.

   The remote source and the server's own view (api/mcp-access.js MCP_WITHHELD) already leave them
   out; a profile read straight from ./data (local mode) or handed to the hosted endpoint is cut
   here too, so there is no path by which a tool could be written to return them by accident.

   habitLog — the daily habit log (frontend/src/lib/habits.js): Alcohol and the user's own habits,
   their names and definitions (`habit|def`), every day and the notes beside them. Health and
   personal data the owner logged for themselves, not training data. Opening any of it to an assistant
   is a decision of its own, with its own consent, and has not been made. */
export const PRIVATE_KEYS = Object.freeze(['habitLog'])

/** `S` without the private parts, as a copy; anything that is not a profile document is returned as it is. */
export function dropPrivate(S) {
  if (!S || typeof S !== 'object' || Array.isArray(S)) return S
  const out = { ...S }
  for (const k of PRIVATE_KEYS) delete out[k]
  return out
}
