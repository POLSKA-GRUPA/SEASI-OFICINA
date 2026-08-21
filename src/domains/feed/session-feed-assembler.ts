/**
 * Assembler incremental del feed de sesión: pliega las notificaciones de
 * streaming del kernel (`seasi.session.event`) en un modelo de UI estable.
 * Cache de presentación, NUNCA fuente de verdad — los hechos viven en el
 * ledger del kernel. Módulo puro; patrón adaptado de stablyai/orca
 * (native-chat-incremental-assembler, MIT).
 *
 * Reglas de plegado:
 *   tool_call abre una acción "running"; el siguiente tool_result la cierra
 *   (FIFO) y fija la duración con los occurred_at de ambos eventos.
 *   Los message consecutivos del mismo adapter se fusionan en un solo item.
 *   hitl_required marca acción warn y phase → paused_hitl.
 *   completed/failed/cancelled cierran la fase y apagan el thinking.
 */

export type SessionStreamEvent = {
  kind: string;
  session_id?: string;
  adapter?: string;
  data?: Record<string, unknown>;
  occurred_at?: string;
};

export type FeedMessage = {
  type: "message";
  id: number;
  adapter: string;
  at: string;
  lines: string[];
};

export type FeedAction = {
  type: "action";
  id: number;
  adapter: string;
  at: string;
  name: string;
  detail: string;
  status: "running" | "ok" | "warn" | "fail";
  durationMs: number | null;
  resultSummary: string | null;
};

export type FeedItem = FeedMessage | FeedAction;

export type SessionPhase = "idle" | "running" | "paused_hitl" | "completed" | "failed" | "cancelled";

export type SessionFeedState = {
  items: FeedItem[];
  phase: SessionPhase;
  thinking: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  nextId: number;
};

export function emptyFeed(): SessionFeedState {
  return { items: [], phase: "idle", thinking: false, turns: 0, inputTokens: 0, outputTokens: 0, nextId: 1 };
}

const MAX_FEED_ITEMS = 1_000;

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageText(data: Record<string, unknown>): string {
  if (typeof data.raw === "string") return data.raw;
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  return asText(data);
}

function actionName(data: Record<string, unknown>): string {
  for (const key of ["tool", "name", "capability_id", "command"]) {
    const v = data[key];
    if (typeof v === "string" && v) return v;
  }
  return "tool";
}

function actionDetail(data: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k !== "tool" && k !== "name") rest[k] = v;
  }
  const s = asText(rest);
  return s === "{}" ? "" : s.slice(0, 400);
}

function durationBetween(startIso: string, endIso: string | undefined): number | null {
  if (!endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

function pushItem(state: SessionFeedState, item: FeedItem): SessionFeedState {
  const items = [...state.items, item];
  return {
    ...state,
    items: items.length > MAX_FEED_ITEMS ? items.slice(items.length - MAX_FEED_ITEMS) : items,
    nextId: state.nextId + 1,
  };
}

export function reduceFeed(state: SessionFeedState, ev: SessionStreamEvent): SessionFeedState {
  const data = ev.data ?? {};
  const adapter = ev.adapter ?? "agente";
  const at = ev.occurred_at ?? new Date().toISOString();

  switch (ev.kind) {
    case "spawned":
      return { ...emptyFeed(), phase: "running", thinking: true, nextId: state.nextId };

    case "message": {
      const text = messageText(data);
      const last = state.items[state.items.length - 1];
      if (last && last.type === "message" && last.adapter === adapter) {
        const merged: FeedMessage = { ...last, lines: [...last.lines, text] };
        return { ...state, items: [...state.items.slice(0, -1), merged], turns: state.turns + 1, thinking: true };
      }
      return {
        ...pushItem(state, { type: "message", id: state.nextId, adapter, at, lines: [text] }),
        turns: state.turns + 1,
        thinking: true,
      };
    }

    case "tool_call":
      return {
        ...pushItem(state, {
          type: "action",
          id: state.nextId,
          adapter,
          at,
          name: actionName(data),
          detail: actionDetail(data),
          status: "running",
          durationMs: null,
          resultSummary: null,
        }),
        turns: state.turns + 1,
        thinking: true,
      };

    case "tool_result": {
      const idx = state.items.findIndex((it) => it.type === "action" && it.status === "running");
      if (idx === -1) return state;
      const open = state.items[idx] as FeedAction;
      const failed = data.ok === false || data.error !== undefined;
      const closed: FeedAction = {
        ...open,
        status: failed ? "fail" : "ok",
        durationMs: durationBetween(open.at, ev.occurred_at),
        resultSummary: actionDetail(data) || null,
      };
      const items = [...state.items];
      items[idx] = closed;
      return { ...state, items };
    }

    case "usage":
      return {
        ...state,
        inputTokens: state.inputTokens + Number(data.input_tokens ?? 0),
        outputTokens: state.outputTokens + Number(data.output_tokens ?? 0),
      };

    case "hitl_required": {
      const next = pushItem(state, {
        type: "action",
        id: state.nextId,
        adapter,
        at,
        name: actionName(data),
        detail: actionDetail(data),
        status: "warn",
        durationMs: null,
        resultSummary: "esperando aprobación HITL",
      });
      return { ...next, phase: "paused_hitl", thinking: false };
    }

    case "completed":
      return { ...state, phase: "completed", thinking: false };
    case "failed":
      return { ...state, phase: "failed", thinking: false };
    case "cancelled":
      return { ...state, phase: "cancelled", thinking: false };

    default:
      return state;
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "context";

/** Clasifica una línea de diff unificado para colorearla con tokens semánticos. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "context";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Heurística barata: ¿este bloque de texto parece un diff unificado? */
export function looksLikeUnifiedDiff(lines: string[]): boolean {
  let signal = 0;
  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) signal += 2;
    else if (line.startsWith("+") || line.startsWith("-")) signal += 1;
  }
  return lines.length > 0 && signal >= Math.max(3, lines.length / 2);
}
