/**
 * Display-only API-key masking. Never print more than the Chargebee key kind
 * (`test_` / `live_`). The rest of the secret stays off-screen.
 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (/^test_/i.test(k)) return "test_…";
  if (/^live_/i.test(k)) return "live_…";
  return "…";
}
