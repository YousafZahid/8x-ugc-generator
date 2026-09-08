/**
 * One JSON-returning call, two free providers, no SDK.
 *
 * Groq and Gemini both expose OpenAI-compatible /chat/completions, so this is
 * one code path with two base URLs rather than two integrations. They are
 * tried in order and the first usable answer wins.
 *
 * The fallback chain is not defensive padding. Free tiers rate-limit exactly
 * when you are demoing, and every caller here has a deterministic non-LLM path
 * behind it - so the worst case is a less clever video, never an error in the
 * chat.
 */

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 15_000);

export type Provider = "groq" | "gemini";

type ProviderSpec = {
  name: Provider;
  url: string;
  key: () => string | undefined;
  model: string;
};

function providers(): ProviderSpec[] {
  return [
    {
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: () => process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
    },
    {
      name: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: () => process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    },
  ];
}

export type JsonRequest = {
  system: string;
  user: string;
  /** Nudges creativity. Routing wants 0, copywriting wants ~0.8. */
  temperature?: number;
  maxTokens?: number;
  /** Try providers in this order. Defaults to groq then gemini. */
  order?: Provider[];
};

export type JsonResponse<T> = {
  data: T | null;
  provider: Provider | null;
  ms: number;
  /** Every provider's failure, for logging. Never surfaced to a user. */
  errors: string[];
};

/**
 * Models wrap JSON in prose or fences no matter how firmly you ask them not
 * to. Pull the first balanced object out rather than trusting the envelope.
 */
export function extractJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to brace matching.
  }

  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(
  spec: ProviderSpec,
  key: string,
  req: JsonRequest,
  jsonMode: boolean
): Promise<Response> {
  return fetch(spec.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: spec.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      // Dropped on the retry - see below.
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      // gpt-oss spends tokens on hidden reasoning before it writes anything.
      // Left at default it exhausts max_tokens mid-thought and returns an
      // empty content field - observed live. Low effort is plenty for
      // filling in a fixed schema.
      ...(/gpt-oss/.test(spec.model) ? { reasoning_effort: "low" } : {}),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 1200,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function callOne<T>(spec: ProviderSpec, req: JsonRequest): Promise<T | null> {
  const key = spec.key();
  if (!key) throw new Error(`${spec.name}: no API key set`);

  let res = await post(spec, key, req, true);

  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, " ");

    // Groq's strict json_object mode returns 400 json_validate_failed when the
    // model's own output does not satisfy it - observed live on duolingo.com.
    // The model is capable, the envelope is not, so retry without the
    // constraint and let extractJson do the work.
    if (res.status === 400 && /json_validate_failed|Failed to generate JSON/i.test(body)) {
      res = await post(spec, key, req, false);
    } else if (res.status === 429 || res.status >= 500) {
      // Transient: free tiers throttle, and Gemini answered 503 under load.
      // One short backoff is worth it before burning the next provider.
      await sleep(700);
      res = await post(spec, key, req, true);
    } else {
      throw new Error(`${spec.name}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
      const retryBody = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${spec.name}: HTTP ${res.status} after retry ${retryBody}`);
    }
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning?: string } }[];
  };
  const message = payload.choices?.[0]?.message;
  // Reasoning models sometimes leave the answer in `reasoning` with `content`
  // empty. The JSON is usually still in there, so look before giving up.
  const content = message?.content || message?.reasoning;
  if (!content) throw new Error(`${spec.name}: empty completion`);

  const parsed = extractJson<T>(content);
  if (!parsed) throw new Error(`${spec.name}: response was not JSON`);
  return parsed;
}

export async function jsonCompletion<T>(req: JsonRequest): Promise<JsonResponse<T>> {
  const started = Date.now();
  const errors: string[] = [];
  const order = req.order ?? ["groq", "gemini"];
  const specs = providers();

  for (const name of order) {
    const spec = specs.find((s) => s.name === name);
    if (!spec) continue;
    try {
      const data = await callOne<T>(spec, req);
      if (data) return { data, provider: spec.name, ms: Date.now() - started, errors };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Both providers down or rate-limited. The caller falls back to heuristics.
  return { data: null, provider: null, ms: Date.now() - started, errors };
}

export function anyLlmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
}
