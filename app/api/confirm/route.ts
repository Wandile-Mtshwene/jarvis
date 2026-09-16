import { resolvePending } from "@/lib/pending";
import { checkAuth } from "@/lib/auth";

export const runtime = "nodejs";

// POST { id: string, approved: boolean } -> resolves a pending confirmation.
export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  const { id, approved } = (await req.json()) as { id: string; approved: boolean };
  const ok = resolvePending(id, !!approved);
  return Response.json({ ok });
}
