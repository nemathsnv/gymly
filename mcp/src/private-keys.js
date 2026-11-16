/* Parts of a profile no MCP tool reads, whichever way the profile reaches this process.

   The remote source and the server's own view (api/mcp-access.js MCP_WITHHELD) already leave them
   out; a profile read straight from ./data (local mode) or handed to the hosted endpoint is cut
   here too, so there is no path by which a tool could be written to return them by accident.

   habitLog — the daily habit log (frontend/src/lib/habits.js): Alcohol and the user's own habits,
   their names and definitions (`habit|def`), every day and the notes beside them. Health and
   personal data the owner logged for themselves, not training data. No tool that reads the profile
   through here sees any of it. The one consented path is separate: on the hosted endpoint, a
   connection whose owner ticked "Also read your habits" on the consent screen (OAuth scope
   gymly:habits:read, never granted by default) can call list_habits and get_habit_log
   (hosted.js HABIT_TOOLS), which copy out habit names, kinds and each day's status and count, field
   by field, and never a note. The stdio bridge and the V1 token have no such path.

   sex, birthYear — About you (frontend/src/components/StrengthLevel.jsx): read only by the
   strength levels on the device, and promised there never to reach the Coach or an assistant. */
export const PRIVATE_KEYS = Object.freeze(['habitLog', 'sex', 'birthYear'])

/** `S` without the private parts, as a copy; anything that is not a profile document is returned as it is. */
export function dropPrivate(S) {
  if (!S || typeof S !== 'object' || Array.isArray(S)) return S
  const out = { ...S }
  for (const k of PRIVATE_KEYS) delete out[k]
  return out
}
