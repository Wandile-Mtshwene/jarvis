// In-memory registry of confirmations awaiting a user decision.
// Jarvis runs as a single local Node process, so a module-level Map is shared
// across the /api/agent (which awaits) and /api/confirm (which resolves) routes.

type Pending = {
  resolve: (approved: boolean) => void;
  tool: string;
  input: unknown;
  reason: string;
};

const registry = new Map<string, Pending>();

export function createPending(
  id: string,
  tool: string,
  input: unknown,
  reason: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Auto-deny after 2 minutes so a forgotten prompt can't hang a turn forever.
    const timer = setTimeout(() => {
      registry.delete(id);
      resolve(false);
    }, 120_000);
    registry.set(id, {
      tool,
      input,
      reason,
      resolve: (approved) => {
        clearTimeout(timer);
        registry.delete(id);
        resolve(approved);
      },
    });
  });
}

export function resolvePending(id: string, approved: boolean): boolean {
  const p = registry.get(id);
  if (!p) return false;
  p.resolve(approved);
  return true;
}
