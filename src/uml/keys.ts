/** Ordered endpoint pair key. The exact `JSON.stringify` form is load-bearing: callers sort it. */
export function pairKey(source: string, target: string): string {
  return JSON.stringify([source, target]);
}

export function unpairKey(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

export function isTestPath(path: string): boolean {
  return /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[tj]sx?$|(^|[\\/])tests\.rs$/
    .test(path);
}

/** Repeated same-file namespace blocks share the occurrence-0 key as their export scope. */
export function canonicalScopeKey(scopeKey: string): string {
  try {
    const parts = JSON.parse(scopeKey) as unknown;
    if (!Array.isArray(parts) || parts.length !== 4) return scopeKey;
    return JSON.stringify([parts[0], parts[1], parts[2], 0]);
  } catch {
    return scopeKey;
  }
}
