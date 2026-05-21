import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface WorkspaceContextSnapshot {
  workspace?: string;
  memory?: string | null;
  documents?: string | null;
  tasks?: string | null;
  canvas?: string | null;
}

interface AgentContext {
  name?: string;
  systemPrompt?: string;
  model?: string;
}

function buildSystemPrompt(
  memory: string | null | undefined,
  documents: string | null | undefined,
  workspaceContext: WorkspaceContextSnapshot | null | undefined,
  agentContext: AgentContext | null | undefined,
): string {
  const sections: string[] = [];

  if (agentContext?.systemPrompt) {
    sections.push(
      `You are "${agentContext.name || 'Agent'}", a custom AI agent in a collaborative workspace. Your personality and instructions:`,
      "",
      agentContext.systemPrompt,
      "",
      "Additionally, follow these workspace guidelines:",
    );
  } else {
    sections.push(
      "You are Hatch AI, a collaborative workspace assistant. You help teams think, write, and get work done inside a shared workspace that contains documents, chats, memory, tasks, files, and a shared canvas.",
    );
  }

  sections.push(
    "",
    "Guidelines:",
    "- Be concise, warm, and thoughtful. Prefer markdown for structure.",
    "- When you reference workspace content, quote the title so teammates can find it.",
    "- When the user asks you to extract or create tasks, emit them on their own lines using this exact format so the app can parse them: `TASK: <title>` (one task per line).",
    "- If you do not know something from the provided context, say so rather than inventing.",
    "- You are one of potentially many people in this workspace; speak in a way that is useful to the whole team, not just a single user.",
  );

  if (workspaceContext) {
    const wsBlocks: string[] = [];
    if (workspaceContext.workspace) {
      wsBlocks.push(`Workspace name: ${workspaceContext.workspace}`);
    }
    if (workspaceContext.memory) {
      wsBlocks.push(`# Team memory\n${workspaceContext.memory}`);
    }
    if (workspaceContext.documents) {
      wsBlocks.push(`# Key documents\n${workspaceContext.documents}`);
    }
    if (workspaceContext.tasks) {
      wsBlocks.push(`# Open tasks\n${workspaceContext.tasks}`);
    }
    if (workspaceContext.canvas) {
      wsBlocks.push(`# Canvas notes\n${workspaceContext.canvas}`);
    }
    if (wsBlocks.length > 0) {
      sections.push(
        "",
        "<workspace_context>",
        "The following is a snapshot of the shared workspace you are assisting in. Use it to answer grounded questions, but do not dump it verbatim unless asked.",
        "",
        wsBlocks.join("\n\n"),
        "</workspace_context>",
      );
    }
  }

  if (memory) {
    sections.push(
      "",
      "<user_memory>",
      "Persistent facts the user has saved. Use this to personalize responses.",
      memory,
      "</user_memory>",
    );
  }

  if (documents) {
    sections.push(
      "",
      "<linked_documents>",
      "The user has explicitly linked these documents for this message. Treat them as high-priority context.",
      documents,
      "</linked_documents>",
    );
  }

  return sections.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { messages, model, memory, documents, workspaceContext, agentContext } = await req.json();

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "AI service not configured. Please add your ANTHROPIC_API_KEY to Supabase secrets." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resolvedModel = !model || model === "auto"
      ? "claude-opus-4-5"
      : model === "claude-opus-4-6"
      ? "claude-opus-4-5"
      : model === "claude-sonnet-4-6"
      ? "claude-sonnet-4-5"
      : model === "claude-haiku-4-5"
      ? "claude-haiku-4-5"
      : "claude-opus-4-5";

    const systemPrompt = buildSystemPrompt(memory, documents, workspaceContext, agentContext);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "messages-2023-12-15",
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 4096,
        stream: true,
        messages: messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
        system: systemPrompt,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return new Response(
        JSON.stringify({ error: `Anthropic API error: ${response.status}`, details: errorBody }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
                const out = JSON.stringify({ delta: { text: parsed.delta.text } });
                controller.enqueue(new TextEncoder().encode(`data: ${out}\n\n`));
              }
            } catch {
              // Ignore malformed SSE chunks and continue streaming valid deltas.
            }
          }
        }
      },
    });

    return new Response(response.body!.pipeThrough(transformStream), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
