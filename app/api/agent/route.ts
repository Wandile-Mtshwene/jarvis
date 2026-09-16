import { runAgent, type Msg } from "@/lib/agent";
import { checkAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { messages: Msg[] } -> Server-Sent Events stream of AgentEvent objects.
export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });

  const { messages, profile } = (await req.json()) as {
    messages: Msg[];
    profile?: { name?: string; notes?: string };
  };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const ev of runAgent(messages ?? [], profile)) send(ev);
      } catch (e) {
        send({ type: "error", message: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
