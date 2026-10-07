/**
 * Unit tests for aiAgentStep (src/lib/ai-gateway.server.ts): request shape and
 * response parsing for each provider's tool-calling dialect. `fetch` is
 * stubbed — no network — and the db / AI-ledger modules are mocked, so the
 * suite needs no database (an explicit `config` skips key lookup).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";

import type { AgentMessage, AgentToolSpec, AiConfig } from "../src/lib/ai-gateway.server";

const ledger: { feature: string; status: string; totalTokens?: number | null }[] = [];
mock.module("../src/server/db", () => ({ db: {} }));
mock.module("../src/server/ai-usage", () => ({
  recordAiUsage: async (row: { feature: string; status: string; totalTokens?: number | null }) => {
    ledger.push(row);
  },
}));
const { aiAgentStep, INVALID_TOOL_ARGS, toolParameters } =
  await import("../src/lib/ai-gateway.server");

beforeEach(() => {
  ledger.length = 0;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Provider request bodies are asserted structurally; their shape is untyped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

type Captured = { url: string; headers: Record<string, string>; body: Body };

function stubFetch(status: number, response: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), {
      status,
    });
  }) as typeof fetch;
  return calls;
}

const cfg = (provider: AiConfig["provider"]): AiConfig => ({
  provider,
  model: "test-model",
  apiKey: "test-key",
});

const lookupTool: AgentToolSpec = {
  name: "get_requisition",
  description: "Read one requisition",
  parameters: toolParameters(z.object({ id: z.string().describe("Requisition id") })),
};

/** A transcript that already contains one tool round-trip with two parallel calls. */
const transcript: AgentMessage[] = [
  { role: "user", content: "Summarise req R1 and R2" },
  {
    role: "assistant",
    content: "Looking them up.",
    toolCalls: [
      { id: "c1", name: "get_requisition", args: { id: "R1" } },
      { id: "c2", name: "get_requisition", args: { id: "R2" } },
    ],
  },
  { role: "tool", toolCallId: "c1", name: "get_requisition", content: '{"title":"SRE"}' },
  {
    role: "tool",
    toolCallId: "c2",
    name: "get_requisition",
    content: "not found",
    isError: true,
  },
];

const run = (provider: AiConfig["provider"], messages = transcript) =>
  aiAgentStep({
    system: "You are a test agent.",
    messages,
    tools: [lookupTool],
    config: cfg(provider),
    feature: "agent_requisition",
  });

describe("toolParameters", () => {
  test("emits a bare JSON Schema object", () => {
    const p = toolParameters(z.object({ id: z.string(), n: z.number().optional() }));
    expect(p["$schema"]).toBeUndefined();
    expect(p["type"]).toBe("object");
    expect(p["required"]).toEqual(["id"]);
  });
});

describe("no key", () => {
  test("returns the vendor-neutral 401 without calling the provider", async () => {
    const calls = stubFetch(200, {});
    const res = await aiAgentStep({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      config: { provider: "openai", model: "m", apiKey: null },
      feature: "agent_requisition",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });
});

describe("openai dialect", () => {
  test("maps tools, assistant tool_calls and tool results", async () => {
    const calls = stubFetch(200, {
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const res = await run("openai");
    const { body, headers, url } = calls[0]!;
    expect(url).toContain("api.openai.com");
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_requisition",
        description: "Read one requisition",
        parameters: lookupTool.parameters,
      },
    });
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a test agent." });
    expect(body.messages[2].tool_calls[1]).toEqual({
      id: "c2",
      type: "function",
      function: { name: "get_requisition", arguments: '{"id":"R2"}' },
    });
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"title":"SRE"}',
    });
    expect(body.messages[4].content).toBe("ERROR: not found");
    expect(ledger).toEqual([
      expect.objectContaining({ feature: "agent_requisition", status: "ok", totalTokens: 15 }),
    ]);
    expect(res).toEqual({
      ok: true,
      text: "done",
      toolCalls: [],
      stopReason: "end",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  test("parses tool calls, including invalid JSON arguments", async () => {
    stubFetch(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "x1",
                type: "function",
                function: { name: "get_requisition", arguments: '{"id":"R9"}' },
              },
              { id: "x2", type: "function", function: { name: "get_requisition", arguments: "{" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const res = await run("openai");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls[0]).toEqual({ id: "x1", name: "get_requisition", args: { id: "R9" } });
    expect(res.toolCalls[1]!.args).toEqual({ [INVALID_TOOL_ARGS]: "{" });
    expect(res.usage).toBeNull();
  });

  test("surfaces provider errors with the shared hints", async () => {
    stubFetch(429, { error: { message: "slow down" } });
    const res = await run("openai");
    expect(res).toEqual({
      ok: false,
      status: 429,
      message: "slow down — rate limited, retry shortly.",
    });
    expect(ledger).toEqual([
      expect.objectContaining({ feature: "agent_requisition", status: "error" }),
    ]);
  });

  test("rejects an unparseable body", async () => {
    stubFetch(200, "<html>oops</html>");
    const res = await run("openai");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });
});

describe("anthropic dialect", () => {
  test("folds parallel tool results into one user turn and alternates roles", async () => {
    const calls = stubFetch(200, {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 3 },
    });
    const res = await run("anthropic");
    const { body, headers, url } = calls[0]!;
    expect(url).toContain("api.anthropic.com");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(body.system).toBe("You are a test agent.");
    expect(body.tools[0]).toEqual({
      name: "get_requisition",
      description: "Read one requisition",
      input_schema: lookupTool.parameters,
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "Looking them up." },
      { type: "tool_use", id: "c1", name: "get_requisition", input: { id: "R1" } },
      { type: "tool_use", id: "c2", name: "get_requisition", input: { id: "R2" } },
    ]);
    expect(body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: '{"title":"SRE"}' },
      { type: "tool_result", tool_use_id: "c2", content: "not found", is_error: true },
    ]);
    expect(res).toEqual({
      ok: true,
      text: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
    });
  });

  test("parses tool_use blocks", async () => {
    stubFetch(200, {
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "tu1", name: "get_requisition", input: { id: "R3" } },
      ],
      stop_reason: "tool_use",
    });
    const res = await run("anthropic");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe("Checking.");
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "tu1", name: "get_requisition", args: { id: "R3" } }]);
  });
});

describe("google dialect", () => {
  test("maps to functionCall / functionResponse parts with a JSON-schema declaration", async () => {
    const calls = stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "fine" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 30, totalTokenCount: 42 },
    });
    const res = await run("google");
    const { body, headers, url } = calls[0]!;
    expect(url).toContain("/test-model:generateContent");
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(
      lookupTool.parameters,
    );
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1].parts[1]).toEqual({
      functionCall: { id: "c1", name: "get_requisition", args: { id: "R1" } },
    });
    expect(body.contents[2].parts).toEqual([
      {
        functionResponse: {
          id: "c1",
          name: "get_requisition",
          response: { result: '{"title":"SRE"}' },
        },
      },
      {
        functionResponse: { id: "c2", name: "get_requisition", response: { error: "not found" } },
      },
    ]);
    expect(res).toEqual({
      ok: true,
      text: "fine",
      toolCalls: [],
      stopReason: "end",
      usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
    });
  });

  test("parses functionCall parts, ignores thoughts, synthesises missing ids", async () => {
    stubFetch(200, {
      candidates: [
        {
          content: {
            parts: [
              { text: "thinking...", thought: true },
              { functionCall: { name: "get_requisition", args: { id: "R4" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    const res = await run("google");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe("");
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "call_0", name: "get_requisition", args: { id: "R4" } }]);
  });

  test("keeps a thinking model's thoughtSignature and sends it back with the call", async () => {
    stubFetch(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { id: "g1", name: "get_requisition", args: { id: "R9" } },
                thoughtSignature: "sig-abc",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    const first = await run("google");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.toolCalls).toEqual([
      { id: "g1", name: "get_requisition", args: { id: "R9" }, signature: "sig-abc" },
    ]);

    // Next turn: the signature travels with the functionCall part, unchanged.
    const calls = stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
    });
    await run("google", [
      { role: "user", content: "Read R9" },
      { role: "assistant", content: "", toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "g1", name: "get_requisition", content: "{}" },
    ]);
    expect(calls[0]!.body.contents[1].parts).toEqual([
      {
        functionCall: { id: "g1", name: "get_requisition", args: { id: "R9" } },
        thoughtSignature: "sig-abc",
      },
    ]);
  });
});
