import { resolvePending } from "@/lib/pending";

export const runtime = "nodejs";

// POST { id: string, approved: boolean } -> resolves a pending confirmation.
export async function POST(req: Request) {
  const { id, approved } = (await req.json()) as { id: string; approved: boolean };
  const ok = resolvePending(id, !!approved);
  return Response.json({ ok });
}
