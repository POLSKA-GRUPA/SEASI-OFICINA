/**
 * La Oficina — event store local del shell.
 *
 * Un único log append-only (`oficina.jsonl` en userData) con hash-chain
 * sha256 es la fuente de verdad de TODO lo humano del despacho: fichaje
 * (control horario auditable), notas del diario y tareas. Las vistas
 * (Diario, reloj, board) son proyecciones derivadas, nunca estado aparte.
 *
 * Diseño (decisión owner 2026-08-19): esto es una mejora del shell, no un
 * módulo del kernel — los eventos de oficina son locales al despacho hasta
 * que el relay (R3) los comparta entre máquinas.
 *
 * Reglas de negocio v0 (fail-closed):
 *   - clock.in con jornada ya abierta     → clock_already_in
 *   - clock.out sin jornada abierta       → clock_not_in
 *   - task.moved sobre id desconocido     → task_unknown
 *   - task.created con id duplicado       → task_duplicate
 *   - payload que no valida su schema     → invalid_payload
 *   - cadena rota al cargar/tamper        → chain_corrupt
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const sha256 = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");

const ActorSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ._-]+$/, "actor con caracteres no permitidos");

const PersonaSchema = ActorSchema;

export const EventPayloadSchemas = {
  "clock.in": z.object({ persona: PersonaSchema, nota: z.string().max(200).optional() }).strict(),
  "clock.out": z.object({ persona: PersonaSchema, nota: z.string().max(200).optional() }).strict(),
  "task.created": z
    .object({
      id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "id de tarea: kebab-case"),
      title: z.string().min(1).max(140),
      area: z.string().max(40).optional(),
      priority: z.enum(["low", "normal", "high"]).optional(),
    })
    .strict(),
  "task.moved": z.object({ id: z.string().min(1).max(64), to: z.enum(["todo", "doing", "done"]) }).strict(),
  note: z.object({ persona: PersonaSchema, text: z.string().min(1).max(2000) }).strict(),
} as const;

export type OficinaEventType = keyof typeof EventPayloadSchemas;
export const OFICINA_EVENT_TYPES = Object.keys(EventPayloadSchemas) as OficinaEventType[];

const TaskStatusSchema = z.enum(["todo", "doing", "done"]);
type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const StoredEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string().min(1), // ISO-8601
  type: z.enum(OFICINA_EVENT_TYPES as [OficinaEventType, ...OficinaEventType[]]),
  actor: ActorSchema,
  payload: z.record(z.string(), z.unknown()),
  prev_hash: z.string().regex(/^(genesis|[0-9a-f]{64})$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

const GENESIS = "genesis";

export class OficinaError extends Error {
  constructor(readonly reason: OficinaReason, message: string) {
    super(message);
    this.name = "OficinaError";
  }
}
export type OficinaReason =
  | "clock_already_in"
  | "clock_not_in"
  | "task_unknown"
  | "task_duplicate"
  | "invalid_payload"
  | "invalid_event"
  | "chain_corrupt"
  | "io";

/** Hash canónico de un evento (lo que firma la cadena). */
export function eventHash(e: Omit<StoredEvent, "hash">): string {
  const canonical = [e.seq, e.ts, e.type, e.actor, JSON.stringify(e.payload), e.prev_hash].join("|");
  return sha256(canonical);
}

export type TaskView = {
  id: string;
  title: string;
  area?: string;
  priority?: "low" | "normal" | "high";
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

export type DiaryEntry = {
  seq: number;
  ts: string;
  type: OficinaEventType;
  actor: string;
  text: string; // una línea legible para el feed
};

export type ClockView = {
  in: boolean;
  persona: string | null;
  since: string | null; // ISO del clock.in abierto
  todayMs: number; // suma de intervalos cerrados de hoy + abierto hasta `now`
};

export type OficinaState = {
  events: number;
  clock: ClockView;
  tasks: TaskView[];
  diary: DiaryEntry[]; // eventos de HOY (local), más nuevos al final
};

const lineOf = (e: StoredEvent): string => {
  switch (e.type) {
    case "clock.in":
      return `fichó${typeof e.payload.nota === "string" && e.payload.nota ? ` — ${e.payload.nota}` : ""}`;
    case "clock.out":
      return `cerró jornada${typeof e.payload.nota === "string" && e.payload.nota ? ` — ${e.payload.nota}` : ""}`;
    case "task.created":
      return `creó tarea «${String(e.payload.title)}»`;
    case "task.moved":
      return `movió «${String(e.payload.id)}» → ${String(e.payload.to)}`;
    case "note":
      return String(e.payload.text);
  }
};

export class OficinaStore {
  private file: string;
  private cache: StoredEvent[] | null = null;

  constructor(file: string) {
    this.file = file;
  }

  /** Carga (y valida cadena) todo el log. Cacheado en memoria. */
  read(): StoredEvent[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = [];
      return this.cache;
    }
    const raw = readFileSync(this.file, "utf8");
    const events: StoredEvent[] = [];
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new OficinaError("chain_corrupt", `línea ${expectedSeq} no es JSON`);
      }
      const ev = StoredEventSchema.safeParse(parsed);
      if (!ev.success) throw new OficinaError("invalid_event", `línea ${expectedSeq} inválida: ${ev.error.message}`);
      if (ev.data.seq !== expectedSeq || ev.data.prev_hash !== prev || ev.data.hash !== eventHash(ev.data)) {
        throw new OficinaError("chain_corrupt", `cadena rota en seq ${expectedSeq}`);
      }
      const payloadCheck = EventPayloadSchemas[ev.data.type].safeParse(ev.data.payload);
      if (!payloadCheck.success) throw new OficinaError("invalid_event", `payload inválido en seq ${expectedSeq}`);
      events.push(ev.data);
      prev = ev.data.hash;
      expectedSeq += 1;
    }
    this.cache = events;
    return events;
  }

  /** Verifica la cadena completa sin cachear (para diagnósticos/backups). */
  verify(): { ok: boolean; events: number; error?: string } {
    this.cache = null;
    try {
      const events = this.read();
      return { ok: true, events: events.length };
    } catch (e) {
      const err = e instanceof OficinaError ? e : new OficinaError("io", String(e));
      return { ok: false, events: 0, error: `${err.reason}: ${err.message}` };
    }
  }

  append(type: OficinaEventType, actor: string, payload: unknown, nowIso?: string): StoredEvent {
    const parsed = EventPayloadSchemas[type].safeParse(payload);
    if (!parsed.success) throw new OficinaError("invalid_payload", parsed.error.message);
    const actorOk = ActorSchema.safeParse(actor);
    if (!actorOk.success) throw new OficinaError("invalid_payload", "actor inválido");

    const events = this.read();
    const last = events[events.length - 1];
    const prev = last ? last.hash : GENESIS;
    const base: Omit<StoredEvent, "hash"> = {
      seq: events.length + 1,
      ts: nowIso ?? new Date().toISOString(),
      type,
      actor,
      payload: parsed.data as Record<string, unknown>,
      prev_hash: prev,
    };
    const ev: StoredEvent = { ...base, hash: eventHash(base) };

    // Reglas de negocio ANTES de persistir (fail-closed: no se escribe nada).
    const pid = (parsed.data as { id?: string }).id;
    if (type === "clock.in" && openInterval(events)) {
      throw new OficinaError("clock_already_in", "ya hay una jornada abierta");
    }
    if (type === "clock.out" && !openInterval(events)) {
      throw new OficinaError("clock_not_in", "no hay jornada abierta");
    }
    if (type === "task.created" && pid !== undefined && events.some((e) => e.type === "task.created" && e.payload.id === pid)) {
      throw new OficinaError("task_duplicate", `tarea ${pid} ya existe`);
    }
    if (type === "task.moved") {
      if (pid === undefined || !events.some((e) => e.type === "task.created" && e.payload.id === pid)) {
        throw new OficinaError("task_unknown", `tarea ${String(pid)} desconocida`);
      }
    }

    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(ev)}\n`, "utf8");
    if (this.cache) this.cache.push(ev);
    return ev;
  }

  /** Proyección completa para la UI. `now` en ISO para tests deterministas. */
  state(nowIso?: string): OficinaState {
    const now = nowIso ?? new Date().toISOString();
    const events = this.read();
    const today = events.filter((e) => sameLocalDay(e.ts, now));
    return {
      events: events.length,
      clock: clockView(events, now),
      tasks: taskView(events),
      diary: today.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, text: lineOf(e) })),
    };
  }
}

// ── proyecciones ──

type Interval = { start: string; end: string | null };

function openInterval(events: StoredEvent[]): Interval | null {
  let open: Interval | null = null;
  for (const e of events) {
    if (e.type === "clock.in") open = { start: e.ts, end: null };
    else if (e.type === "clock.out" && open) open = { start: open.start, end: e.ts };
  }
  return open && !open.end ? open : null;
}

function clockView(events: StoredEvent[], nowIso: string): ClockView {
  const today = events.filter((e) => e.type === "clock.in" || e.type === "clock.out");
  const opened = openInterval(today);
  let todayMs = 0;
  let cursor: string | null = null;
  let dayStart: string | null = null;
  let persona: string | null = null;
  for (const e of today) {
    if (e.type === "clock.in") {
      cursor = e.ts;
      dayStart = dayStart ?? e.ts;
      persona = typeof e.payload.persona === "string" ? (e.payload.persona as string) : persona;
    } else if (e.type === "clock.out" && cursor) {
      if (sameLocalDay(cursor, e.ts) || sameLocalDay(e.ts, nowIso)) {
        todayMs += Math.max(0, Date.parse(e.ts) - Date.parse(cursor));
      }
      cursor = null;
    }
  }
  if (cursor && sameLocalDay(cursor, nowIso)) {
    todayMs += Math.max(0, Date.parse(nowIso) - Date.parse(cursor));
  }
  return {
    in: Boolean(opened && sameLocalDay(opened.start, nowIso)),
    persona,
    since: opened && sameLocalDay(opened.start, nowIso) ? opened.start : null,
    todayMs,
  };
}

function taskView(events: StoredEvent[]): TaskView[] {
  const tasks = new Map<string, TaskView>();
  for (const e of events) {
    if (e.type === "task.created") {
      const p = e.payload as { id: string; title: string; area?: string; priority?: "low" | "normal" | "high" };
      tasks.set(p.id, {
        id: p.id,
        title: p.title,
        area: p.area,
        priority: p.priority,
        status: "todo",
        created_at: e.ts,
        updated_at: e.ts,
      });
    } else if (e.type === "task.moved") {
      const p = e.payload as { id: string; to: TaskStatus };
      const t = tasks.get(p.id);
      if (t) {
        t.status = p.to;
        t.updated_at = e.ts;
      }
    }
  }
  return [...tasks.values()];
}

/** ¿Mismo día LOCAL? El diario de la oficina corre en el reloj del despacho. */
export function sameLocalDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}
