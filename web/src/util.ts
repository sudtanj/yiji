export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

// yiji-wasm rejects with plain strings, everything else with Error.
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
