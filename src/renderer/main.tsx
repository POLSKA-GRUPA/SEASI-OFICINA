import { createRoot } from "react-dom/client";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { KernelClient, KernelError, type AgentSessionLike, type HitlPauseLike, type UsageRow } from "../domains/kernel-bridge/client";
import { buildGraph, extractWikilinks, parseRoadmapBoard, type BoardCard } from "../domains/brain/parser";
import {
  classifyDiffLine,
  emptyFeed,
  looksLikeUnifiedDiff,
  reduceFeed,
  summarizeFeed,
  type FeedAction,
  type FeedItem,
  type SessionFeedState,
  type SessionStreamEvent,
} from "../domains/feed/session-feed-assembler";
import { filterPalette, type PaletteEntry } from "../domains/quick-open/matcher";
import {
  composeFollowUp,
  createNote,
  markPendingSent,
  parseStoredNotes,
  pendingNotes,
  removeNote,
  type ReviewNote,
} from "../domains/review/notes";
import type { TenantConfig } from "../domains/branding/config";
import type { OficinaState } from "../domains/oficina/store";
import "./ui.css";

type Bridge = {
  version: string;
  call: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
  shell: {
    vaultList: () => Promise<{ name: string; set: boolean }[]>;
    vaultSet: (n: string, v: string) => Promise<{ ok: boolean }>;
    vaultDelete: (n: string) => Promise<boolean>;
    brainList: () => Promise<string[]>;
    brainRead: (n: string) => Promise<string>;
    brainWrite: (n: string, c: string) => Promise<{ ok: boolean }>;
    backupCreate: () => Promise<unknown>;
    backupList: () => Promise<string[]>;
    backupVerify: (id: string) => Promise<unknown>;
    updateCheck: () => Promise<unknown>;
    branding: () => Promise<unknown>;
    mcpStatus: () => Promise<unknown>;
    onSessionEvent: (cb: (payload: { method: string; params: unknown }) => void) => () => void;
    diagnosticsExport: () => Promise<{ exported: boolean; path: string }>;
    oficinaState: (persona?: string) => Promise<OficinaState>;
    oficinaAppend: (type: string, actor: string, payload: unknown) => Promise<{ ok: true; event: unknown } | { ok: false; reason: string; message: string }>;
    oficinaVerify: () => Promise<{ ok: boolean; events: number; error?: string }>;
    onOficinaEvent: (
      cb: (payload: { seq?: number; type?: string; kind?: string; actor?: string; status?: string; online?: { persona: string; since: string }[] }) => void,
    ) => () => void;
    oficinaIdentify: (persona: string) => Promise<{ ok: boolean }>;
    relayStatus: () => Promise<{
      configured: boolean;
      status: "off" | "connecting" | "online";
      url: string | null;
      roster: { persona: string; since: string }[];
    }>;
  };
};

const bridge = (window as unknown as { seasi?: Bridge }).seasi;
const kernel = new KernelClient((m, p) => {
  if (!bridge) return Promise.reject(new Error("bridge preload no disponible"));
  return bridge.call(m, p);
});

const IS_MAC = navigator.userAgent.includes("Mac");
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl+";

function BrandMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="120" fill="#17171b" />
      <path d="M256 86 L398 168 L398 344 L256 426 L114 344 L114 168 Z" fill="none"
        stroke="var(--brand-primary)" strokeWidth="24" strokeLinejoin="round" />
      <circle cx="256" cy="180" r="30" fill="var(--brand-primary)" />
      <circle cx="256" cy="340" r="26" fill="#1d1d22" stroke="var(--brand-primary)" strokeWidth="12" />
    </svg>
  );
}

type View = "chat" | "oficina" | "uso" | "brain" | "vault" | "sistema";

const DOCK: { view: View; icon: string; title: string }[] = [
  { view: "chat", icon: "◧", title: "Chat" },
  { view: "oficina", icon: "▦", title: "Oficina" },
  { view: "uso", icon: "▤", title: "Uso" },
  { view: "brain", icon: "◈", title: "Brain" },
  { view: "vault", icon: "▥", title: "Vault" },
  { view: "sistema", icon: "⚙", title: "Sistema" },
];

const fmtClock = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

type SessionRow = AgentSessionLike & { clientLabel: string };

export function App(): JSX.Element {
  const [view, setView] = useState<View>("chat");
  const [tenant, setTenant] = useState<TenantConfig | null>(null);
  const [kernelVersion, setKernelVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [pending, setPending] = useState<HitlPauseLike[]>([]);
  const [chatUnread, setChatUnread] = useState(false);
  const [ledger, setLedger] = useState<{ events: number; ok: boolean } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [usageTotals, setUsageTotals] = useState<{ sessions: number; tokens: number } | null>(null);
  const [promptSeed, setPromptSeed] = useState<string | null>(null);

  // feeds por sesión: cache de presentación (la verdad vive en el ledger)
  const feedsRef = useRef(new Map<string, SessionFeedState>());
  const [feedTick, setFeedTick] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (!bridge) { setError("preload no disponible (¿ejecución fuera de Electron?)"); return; }
    bridge.shell.branding().then((b) => setTenant(b as TenantConfig)).catch((e: unknown) => setError(String(e)));
    kernel.version().then((v) => setKernelVersion(v.kernel_version)).catch(() => setKernelVersion(null));
  }, []);

  // marca white-label: SOLO variables de marca; los tokens de confianza
  // (--v/--ok/--warn/--danger) son constantes del producto
  const brandName = tenant?.branding.name ?? "SEASI";
  useEffect(() => {
    if (tenant?.branding.colors) {
      document.documentElement.style.setProperty("--brand-primary", tenant.branding.colors.primary);
      if (tenant.branding.colors.accent) document.documentElement.style.setProperty("--brand-accent", tenant.branding.colors.accent);
      if (tenant.branding.colors.bg) document.documentElement.style.setProperty("--brand-bg", tenant.branding.colors.bg);
    }
  }, [tenant]);

  // streaming del kernel → assembler incremental por sesión
  useEffect(() => {
    if (!bridge) return;
    return bridge.shell.onSessionEvent(({ params }) => {
      const p = params as { session_id?: string; event?: SessionStreamEvent };
      if (!p.event) return;
      const sid = p.session_id ?? String(p.event.session_id ?? "");
      if (!sid) return;
      const prev = feedsRef.current.get(sid) ?? emptyFeed();
      feedsRef.current.set(sid, reduceFeed(prev, p.event));
      setFeedTick((t) => t + 1);
      if (viewRef.current !== "chat") setChatUnread(true);
    });
  }, []);

  // sesiones desde el ledger (autoridad: kernel)
  const reloadSessions = useCallback(() => {
    kernel.eventTail("pgk", 200).then((events) => {
      const byId = new Map<string, SessionRow>();
      for (const ev of [...events].reverse()) {
        if (ev.event_type === "session.created" && ev.payload.session_id) {
          const s = ev.payload as unknown as AgentSessionLike;
          const sid = String(s.session_id);
          if (!byId.has(sid)) byId.set(sid, { ...s, clientLabel: s.client_ref });
        }
      }
      setSessions([...byId.values()]);
      setLedger({ events: events.length, ok: true });
    }).catch(() => setSessions([]));
  }, []);
  useEffect(() => { reloadSessions(); const t = setInterval(reloadSessions, 5000); return () => clearInterval(t); }, [reloadSessions]);

  // cola HITL + notificación nativa cuando entra una pausa nueva
  const knownPauses = useRef(new Set<string>());
  const reloadPending = useCallback(() => {
    kernel.listPendingHitl("pgk").then((rows) => {
      setPending(rows);
      for (const p of rows) {
        const id = String(p.pause_id);
        if (!knownPauses.current.has(id)) {
          knownPauses.current.add(id);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Aprobación pendiente", { body: `${p.capability_id} espera decisión humana` });
          }
        }
      }
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    reloadPending();
    const t = setInterval(reloadPending, 4000);
    return () => clearInterval(t);
  }, [reloadPending]);

  // uso global (autoridad: kernel) para la status bar
  useEffect(() => {
    const load = () => {
      kernel.usageSummary("pgk").then((rows) => {
        setUsageTotals({
          sessions: rows.length,
          tokens: rows.reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0),
        });
      }).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // atajos: mod+1..6 cambian de vista; mod+K abre Quick Open (⌘ en macOS, Ctrl en el resto)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPaletteOpen(false); return; }
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const target = DOCK[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        setView(target.view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (view === "chat") setChatUnread(false); }, [view, feedTick]);

  const selectedFeed = selectedSession ? feedsRef.current.get(selectedSession) ?? null : null;
  const selectedRow = sessions.find((s) => String(s.session_id) === selectedSession) ?? null;

  const phaseFor = (sid: string): SessionFeedState["phase"] | null =>
    feedsRef.current.get(sid)?.phase ?? null;

  const startNewSession = () => { setSelectedSession(null); setView("chat"); };

  const paletteEntries: PaletteEntry[] = [
    { id: "action:new-session", kind: "action", title: "Nueva sesión", subtitle: "crear un encargo nuevo en Chat", keywords: "crear session nueva" },
    ...DOCK.map((d, i): PaletteEntry => ({ id: `view:${d.view}`, kind: "view", title: d.title, subtitle: `vista · ${MOD_LABEL}${i + 1}` })),
    ...sessions.map((s): PaletteEntry => ({
      id: `session:${String(s.session_id)}`,
      kind: "session",
      title: s.clientLabel,
      subtitle: `${s.period_ref} · ${s.adapter} · ${String(s.session_id).slice(0, 8)}`,
    })),
  ];

  const onPalettePick = (entry: PaletteEntry) => {
    setPaletteOpen(false);
    if (entry.id === "action:new-session") { startNewSession(); return; }
    if (entry.kind === "view") { setView(entry.id.slice("view:".length) as View); return; }
    if (entry.kind === "session") { setSelectedSession(entry.id.slice("session:".length)); setView("chat"); }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><BrandMark /> {brandName.split(" — ")[0]} <em>Oficina</em></div>
        {selectedRow && (
          <div className="crumb"><b>{selectedRow.clientLabel}</b> › {selectedRow.period_ref}</div>
        )}
        <div className="grow" />
        <span className="pill"><span className={`dot ${kernelVersion ? "" : "off"}`} />{kernelVersion ? `kernel ${kernelVersion}` : "kernel…"}</span>
        <span className="pill"><span className={`dot ${ledger?.ok ? "v" : "off"}`} />ledger {ledger ? "✓" : "…"}</span>
        <span className="pill">{tenant?.tenant_id ?? "…"}</span>
      </header>

      <nav className="dock">
        {DOCK.map((d, i) => (
          <button
            key={d.view}
            className={`dk ${view === d.view ? "on" : ""}`}
            title={`${d.title} (${MOD_LABEL}${i + 1})`}
            onClick={() => setView(d.view)}
          >
            {d.icon}
            {d.view === "chat" && chatUnread && view !== "chat" && <span className="unread" />}
          </button>
        ))}
      </nav>

      <aside className="agents">
        <div className="label">
          Agentes <span className="kbd">{MOD_LABEL}K</span>
          <button className="newsess" title="Nueva sesión" onClick={startNewSession}>+</button>
        </div>
        {sessions.length === 0 && <div className="rempty" style={{ margin: "4px 8px" }}>Sin sesiones — crea la primera en Chat.</div>}
        {sessions.map((s) => {
          const sid = String(s.session_id);
          const phase = phaseFor(sid);
          const stClass = phase === "running" ? "run" : phase === "completed" ? "done" : phase === "paused_hitl" ? "warn" : phase === "failed" ? "fail" : "idle";
          return (
            <button
              key={sid}
              className={`agent ${selectedSession === sid ? "on" : ""}`}
              onClick={() => { setSelectedSession(sid); setView("chat"); }}
            >
              <div className="avatar">{s.adapter === "echo" ? "▣" : "🐉"}</div>
              <div>
                <div className="nm">{s.clientLabel}</div>
                <div className="rl">{s.period_ref} · {s.adapter}</div>
              </div>
              <div className={`st ${stClass}`} />
            </button>
          );
        })}
        <div className="label" style={{ marginTop: 10 }}>Clientes</div>
        {[...new Set(sessions.map((s) => s.clientLabel))].map((c) => (
          <button key={c} className="client">{c} <span className="nif">{sessions.filter((s) => s.clientLabel === c).length} ses.</span></button>
        ))}
      </aside>

      <main className={`center ${view === "chat" ? "" : "wide"}`}>
        {error && <div className="banner err" style={{ margin: 12 }}>{error}</div>}
        {view === "chat" && (
          <ChatView
            selected={selectedSession}
            feed={selectedFeed}
            onSessionCreated={(sid) => { setSelectedSession(sid); reloadSessions(); }}
            seed={promptSeed}
            onSeedConsumed={() => setPromptSeed(null)}
          />
        )}
        {view !== "chat" && (
          <section className="view">
            {view === "oficina" && <OficinaView />}
            {view === "uso" && <UsageView />}
            {view === "brain" && <BrainView onDelegate={(text) => { setPromptSeed(text); setView("chat"); }} />}
            {view === "vault" && <VaultView />}
            {view === "sistema" && <SystemView onTenantLoaded={setTenant} />}
          </section>
        )}
      </main>

      {view === "chat" && <RightPanel pending={pending} onDecided={reloadPending} feed={selectedFeed} session={selectedRow} />}

      <footer className="status">
        <span>sesión <span className="val">{selectedSession ? selectedSession.slice(0, 8) : "—"}</span></span>
        <span>turnos <span className="val">{selectedFeed?.turns ?? 0}</span></span>
        <span>tokens <span className="val">{(selectedFeed?.inputTokens ?? 0) + (selectedFeed?.outputTokens ?? 0)}</span></span>
        <span>hitl <span className={pending.length > 0 ? "lv" : "val"}>{pending.length}</span></span>
        <div className="grow" />
        {usageTotals && (
          <span>uso total <span className="val">{usageTotals.tokens} tk · {usageTotals.sessions} ses.</span></span>
        )}
        <span>local-first · sin telemetría · {tenant?.tenant_id ?? "pgk"}</span>
      </footer>

      {paletteOpen && <QuickOpen entries={paletteEntries} onPick={onPalettePick} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------- quick open

function QuickOpen(props: {
  entries: PaletteEntry[];
  onPick: (entry: PaletteEntry) => void;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const results = filterPalette(props.entries, q, 8);
  const sel = results.length === 0 ? 0 : Math.min(idx, results.length - 1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const picked = results[sel];
      if (picked) props.onPick(picked);
    }
  };

  const badge = (kind: PaletteEntry["kind"]): string =>
    kind === "view" ? "vista" : kind === "session" ? "sesión" : "acción";

  return (
    <div className="qo-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="qo">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={onKeyDown}
          placeholder="Ir a vista, sesión o acción…"
          spellCheck={false}
        />
        <div className="qo-list">
          {results.length === 0 && <div className="qo-empty">Sin resultados</div>}
          {results.map((r, i) => (
            <button
              key={r.id}
              className={`qo-item ${i === sel ? "on" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => props.onPick(r)}
            >
              <span className="qo-kind">{badge(r.kind)}</span>
              <span className="qo-title">{r.title}</span>
              {r.subtitle && <span className="qo-sub">{r.subtitle}</span>}
            </button>
          ))}
        </div>
        <div className="qo-hint">↑↓ navegar · ↵ abrir · esc cerrar</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- chat

function ChatView(props: {
  selected: string | null;
  feed: SessionFeedState | null;
  onSessionCreated: (sid: string) => void;
  seed: string | null;
  onSeedConsumed: () => void;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [clientRef, setClientRef] = useState("");
  const [period, setPeriod] = useState("2026T3");

  const [queue, setQueue] = useState<string[]>([]);
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [annotating, setAnnotating] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const feedRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const itemCount = props.feed?.items.length ?? 0;

  // borrador por sesión: sobrevive a cambios de sesión y reinicios de la app
  useEffect(() => {
    setPrompt(props.selected ? localStorage.getItem(`seasi.draft.${props.selected}`) ?? "" : "");
    setQueue([]);
    setNotes(props.selected ? parseStoredNotes(localStorage.getItem(`seasi.notes.${props.selected}`)) : []);
    setAnnotating(null);
    setNoteDraft("");
  }, [props.selected]);

  // semilla de prompt (p.ej. encargo lanzado desde una tarjeta del Brain)
  useEffect(() => {
    if (props.seed !== null) {
      setPrompt(props.seed);
      props.onSeedConsumed();
    }
  }, [props.seed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!props.selected) return;
    const key = `seasi.draft.${props.selected}`;
    if (prompt) localStorage.setItem(key, prompt);
    else localStorage.removeItem(key);
  }, [prompt, props.selected]);

  // autoscroll: pegado abajo sigue el stream; si el humano sube, no se le roba el scroll
  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [itemCount, atBottom, props.feed?.thinking]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const jumpToLatest = () => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const createSession = async () => {
    setBusy(true); setMsg(null);
    try {
      const s = await kernel.startSession({ tenant_id: "pgk", client_ref: clientRef || "SIN-NIF", period_ref: period });
      props.onSessionCreated(String(s.session_id));
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof KernelError ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const runPrompt = useCallback(async (sessionId: string, text: string) => {
    setBusy(true); setMsg(null);
    try {
      await kernel.runSession({ tenant_id: "pgk", session_id: sessionId, prompt: text });
    } catch (e) {
      setMsg(e instanceof KernelError ? e.message : String(e));
    } finally { setBusy(false); }
  }, []);

  // Enter encola: si hay un turno en vuelo, el prompt espera su turno
  const send = () => {
    if (!props.selected || !prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    if (busy) setQueue((q) => [...q, text]);
    else void runPrompt(props.selected, text);
  };

  useEffect(() => {
    if (busy || queue.length === 0 || !props.selected) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    if (next !== undefined) void runPrompt(props.selected, next);
  }, [busy, queue, props.selected, runPrompt]);

  const stop = () => {
    setQueue([]);
    setMsg(busy ? "cola vaciada — el turno en curso terminará (cancel en kernel: pendiente en SEASI-CORE)" : "cola vaciada");
  };

  // notas de revisión: locales hasta enviarse como follow-up batch
  const saveNotes = (next: ReviewNote[]) => {
    setNotes(next);
    if (props.selected) localStorage.setItem(`seasi.notes.${props.selected}`, JSON.stringify(next));
  };

  const addNote = (item: FeedItem) => {
    const text = noteDraft.trim();
    if (!text) return;
    const itemLabel = item.type === "action" ? `acard ${item.name}` : `mensaje ${fmtClock(item.at)}`;
    const quote = (item.type === "action" ? item.detail : item.lines[0] ?? "").slice(0, 80);
    const nextId = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    saveNotes([...notes, createNote({ id: nextId, itemId: item.id, itemLabel, quote, text, createdAt: new Date().toISOString() })]);
    setAnnotating(null);
    setNoteDraft("");
  };

  const pendings = pendingNotes(notes);

  const sendNotes = () => {
    if (!props.selected || pendings.length === 0) return;
    const followUp = composeFollowUp(notes);
    saveNotes(markPendingSent(notes, new Date().toISOString()));
    if (busy) setQueue((q) => [...q, followUp]);
    else void runPrompt(props.selected, followUp);
  };

  const turns = props.feed?.turns ?? 0;
  const dots = Array.from({ length: 10 }, (_, i) => i < Math.min(10, turns));

  return (
    <>
      <div className="feedwrap">
        <div className="feed" ref={feedRef} onScroll={onScroll}>
          {!props.selected && (
            <div className="card" style={{ maxWidth: 460, margin: "40px auto" }}>
              <p className="kicker">Nueva sesión</p>
              <div className="field">
                <label>Cliente (NIF/CIF)</label>
                <input value={clientRef} onChange={(e) => setClientRef(e.target.value)} placeholder="B82211806" />
              </div>
              <div className="field">
                <label>Periodo</label>
                <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026T3" />
              </div>
              <button className="primary" disabled={busy} onClick={() => void createSession()}>Crear sesión</button>
              {msg && <p className="meta" style={{ marginTop: 8 }}>{msg}</p>}
            </div>
          )}
          {props.selected && itemCount === 0 && !props.feed?.thinking && (
            <div className="empty">Sesión lista. Escribe abajo y el agente empieza a trabajar.</div>
          )}
          {props.feed?.items.map((item) => (
            <FeedItemView
              key={item.id}
              item={item}
              noteCount={notes.filter((n) => n.itemId === item.id).length}
              annotating={annotating === item.id}
              onAnnotate={() => { setAnnotating(annotating === item.id ? null : item.id); setNoteDraft(""); }}
              noteDraft={noteDraft}
              onNoteDraft={setNoteDraft}
              onNoteSubmit={() => addNote(item)}
            />
          ))}
          {props.feed?.thinking && (
            <div className="thinking"><div className="orb" />el agente está trabajando…</div>
          )}
          {props.feed?.phase === "paused_hitl" && !props.feed.thinking && (
            <div className="thinking" style={{ opacity: .8 }}>⏸ pausada — esperando aprobación en el panel derecho</div>
          )}
          {props.feed && <SummaryCard feed={props.feed} />}
        </div>
        {!atBottom && itemCount > 0 && (
          <button className="jump" onClick={jumpToLatest}>↓ ir a lo último</button>
        )}
      </div>

      <div className="composer">
        {pendings.length > 0 && (
          <div className="notesbar">
            <span className="nb-title">✎ {pendings.length} nota{pendings.length > 1 ? "s" : ""} de revisión</span>
            {pendings.map((n) => (
              <span key={n.id} className="nb-note" title={n.text}>
                {n.itemLabel}
                <button className="nb-x" title="descartar nota" onClick={() => saveNotes(removeNote(notes, n.id))}>×</button>
              </span>
            ))}
            <button className="nb-send" onClick={sendNotes}>Enviar {pendings.length} nota{pendings.length > 1 ? "s" : ""} ↵</button>
          </div>
        )}
        <div className="ctx-dots">
          {dots.map((on, i) => <div key={i} className={`d ${on ? "on" : ""}`} />)}
          <span className="tks">
            {(props.feed?.inputTokens ?? 0) + (props.feed?.outputTokens ?? 0)} tokens · {turns} turnos
          </span>
        </div>
        <div className="inbox">
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder={props.selected
              ? busy ? "El agente está trabajando — Enter encola tu siguiente encargo" : "Pide lo que quieras — HITL protege todo efecto externo"
              : "Crea una sesión arriba para empezar"}
            disabled={!props.selected}
          />
          <div className="row">
            <span className="bpill model">kernel JSON-RPC</span>
            <span className="bpill">HITL ⏸ efectos</span>
            {queue.length > 0 && <span className="bpill queued">{queue.length} en cola</span>}
            {msg && <span className="bpill" style={{ color: "var(--danger)" }}>{msg.slice(0, 80)}</span>}
            {(busy || queue.length > 0) && (
              <button className="b-no stopbtn" onClick={stop} title="Vacía la cola de encargos pendientes">■ Parar cola</button>
            )}
            <button className="send" disabled={!props.selected || !prompt.trim()} onClick={send}>
              {busy ? "Encolar ↵" : "Enviar ↵"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryCard({ feed }: { feed: SessionFeedState }): JSX.Element | null {
  const s = summarizeFeed(feed);
  if (!s) return null;
  const tone = s.outcome === "completed" ? "ok" : s.outcome === "failed" ? "fail" : "warn";
  const headline = s.outcome === "completed" ? "✓ Sesión completada" : s.outcome === "failed" ? "✗ Sesión fallida" : "⊘ Sesión cancelada";
  return (
    <div className={`sumcard ${tone}`}>
      <div className="hd">{headline} · {s.turns} turnos · {s.totalTokens} tokens</div>
      {s.doneActions.length > 0 && <div className="ln"><span className="k ok">hecho</span>{s.doneActions.join(", ")}</div>}
      {s.failedActions.length > 0 && <div className="ln"><span className="k fail">falló</span>{s.failedActions.join(", ")}</div>}
      {s.pendingHitl.length > 0 && <div className="ln"><span className="k warn">esperando HITL</span>{s.pendingHitl.join(", ")}</div>}
      {s.doneActions.length === 0 && s.failedActions.length === 0 && s.pendingHitl.length === 0 && (
        <div className="ln"><span className="k">acciones</span>ninguna acción ejecutada</div>
      )}
      <div className="ln"><span className="k">siguiente</span>{s.nextStep}</div>
    </div>
  );
}

function FeedItemView(props: {
  item: FeedItem;
  noteCount: number;
  annotating: boolean;
  onAnnotate: () => void;
  noteDraft: string;
  onNoteDraft: (v: string) => void;
  onNoteSubmit: () => void;
}): JSX.Element {
  const { item } = props;
  const [open, setOpen] = useState(false);

  const noteBtn = (
    <button
      className={`notebtn ${props.noteCount > 0 ? "has" : ""}`}
      title="anotar para revisión"
      onClick={(e) => { e.stopPropagation(); props.onAnnotate(); }}
    >
      ✎{props.noteCount > 0 ? props.noteCount : ""}
    </button>
  );

  const noteForm = props.annotating && (
    <div className="noteform">
      <input
        autoFocus
        value={props.noteDraft}
        onChange={(e) => props.onNoteDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); props.onNoteSubmit(); } }}
        placeholder="Nota de revisión — se enviará al agente en batch"
      />
      <button className="b-ok" onClick={props.onNoteSubmit}>Anotar</button>
    </div>
  );

  if (item.type === "message") {
    const isDiff = looksLikeUnifiedDiff(item.lines);
    return (
      <div className="msg">
        <div className="who">🐉</div>
        <div className="body">
          <div className="meta-ln"><b>{item.adapter}</b> · {fmtClock(item.at)} {noteBtn}</div>
          {isDiff ? (
            <div className="txt diff">
              {item.lines.map((line, i) => <div key={i} className={classifyDiffLine(line)}>{line}</div>)}
            </div>
          ) : (
            <div className="txt">{item.lines.join("\n")}</div>
          )}
          {noteForm}
        </div>
      </div>
    );
  }
  const a: FeedAction = item;
  const statusClass = a.status === "running" ? "running" : a.status === "warn" ? "warn" : a.status === "fail" ? "fail" : "";
  const mark = a.status === "running" ? "…" : a.status === "warn" ? "⏳" : a.status === "fail" ? "✗" : "✓";
  return (
    <>
      <div className={`acard ${statusClass}`} onClick={() => setOpen((o) => !o)} title={open ? "plegar" : "expandir"}>
        <div className="ic">{a.status === "warn" ? "⏸" : "⚙"}</div>
        <div className="act">{a.name}</div>
        {a.resultSummary && <div className="res">{a.resultSummary}</div>}
        {a.durationMs !== null && <div className="t">{(a.durationMs / 1000).toFixed(1)}s</div>}
        {noteBtn}
        <div className="ck">{mark}</div>
      </div>
      {noteForm}
      {open && (a.detail || a.resultSummary) && (
        <div className="acard-detail">
          {a.detail && <>args: {a.detail}{"\n"}</>}
          {a.resultSummary && <>result: {a.resultSummary}</>}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------- panel derecho

function RightPanel(props: {
  pending: HitlPauseLike[];
  onDecided: () => void;
  feed: SessionFeedState | null;
  session: SessionRow | null;
}): JSX.Element {
  const [msg, setMsg] = useState<string | null>(null);
  const [actor] = useState(() => localStorage.getItem("oficina.persona") ?? "asesor");

  const decide = async (pause: HitlPauseLike, decision: "approved" | "rejected") => {
    try {
      await kernel.decideHitl({ pause_id: String(pause.pause_id), decision, actor });
      setMsg(`${decision === "approved" ? "✓ aprobado" : "✗ rechazado"} · ${pause.capability_id}`);
      props.onDecided();
    } catch (e) {
      setMsg(e instanceof KernelError ? e.message : String(e));
    }
  };

  return (
    <aside className="right">
      <div className="rsec">
        <div className="hd">
          <div className="label">Aprobaciones</div>
          {props.pending.length > 0 && <div className="cnt">{props.pending.length}</div>}
        </div>
        {props.pending.length === 0 && <div className="rempty">Sin pausas pendientes. Todo efecto externo se congela aquí hasta decisión humana.</div>}
        {props.pending.map((p) => (
          <div key={String(p.pause_id)} className="hitl">
            <div className="cap">{p.capability_id}</div>
            <div className="sub">sesión {String(p.session_id).slice(0, 8)} · expira {fmtClock(p.expires_at)}</div>
            <div className="dg">sha256 {p.payload_digest}</div>
            <div className="btns">
              <button className="b-ok" onClick={() => void decide(p, "approved")}>Aprobar</button>
              <button className="b-no" onClick={() => void decide(p, "rejected")}>Rechazar</button>
            </div>
          </div>
        ))}
        {msg && <div className="rempty">{msg}</div>}
      </div>

      <div className="prev">
        <div className="prev-bar">
          <span className="ic">⟲</span>
          <div className="url">{props.session ? `sesión://${String(props.session.session_id).slice(0, 8)}` : "sesión://—"}</div>
        </div>
        <div className="prev-body">
          {!props.session && <>Selecciona una sesión para ver su resumen.</>}
          {props.session && (
            <>
              <div className="kv"><span>cliente</span><b>{props.session.clientLabel}</b></div>
              <div className="kv"><span>periodo</span><b>{props.session.period_ref}</b></div>
              <div className="kv"><span>adapter</span><b>{props.session.adapter}</b></div>
              <div className="kv"><span>estado stream</span><b>{props.feed?.phase ?? "sin stream"}</b></div>
              <div className="kv"><span>acciones</span><b>{props.feed?.items.filter((i) => i.type === "action").length ?? 0}</b></div>
              <div className="kv"><span>tokens in/out</span><b>{props.feed?.inputTokens ?? 0}/{props.feed?.outputTokens ?? 0}</b></div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------- uso

function UsageView(): JSX.Element {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    kernel.usageSummary("pgk").then(setRows).catch((e: unknown) => setErr(String(e)));
  }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t); }, [reload]);

  const totals = rows.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      input: acc.input + r.input_tokens,
      output: acc.output + r.output_tokens,
    }),
    { turns: 0, input: 0, output: 0 },
  );

  return (
    <div>
      <div className="card">
        <h3>Uso por sesión — total: {rows.length} sesiones · {totals.turns} turnos · {totals.input.toLocaleString()} in / {totals.output.toLocaleString()} out tokens</h3>
        {err && <div className="banner err">{err}</div>}
        <table style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Cliente</th><th>Periodo</th><th>Modelo</th>
              <th className="num">Turnos</th>
              <th className="num">Tokens in</th>
              <th className="num">Tokens out</th>
              <th>Sesión</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.session_id}>
                <td><strong>{r.client_ref}</strong></td>
                <td className="mono">{r.period_ref}</td>
                <td className="mono">{r.model ?? "—"}</td>
                <td className="num mono">{r.turns}</td>
                <td className="num mono">{r.input_tokens.toLocaleString()}</td>
                <td className="num mono">{r.output_tokens.toLocaleString()}</td>
                <td className="mono">{r.session_id.slice(0, 8)}…</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="meta">Sin sesiones con uso registrado todavía.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Proxy MCP OAuth</h3>
        <McpStatusInline />
      </div>
    </div>
  );
}

function McpStatusInline(): JSX.Element {
  const [status, setStatus] = useState<{ running: boolean; port: number; upstream: string | null } | null>(null);
  useEffect(() => {
    bridge?.shell.mcpStatus().then((s) => setStatus(s as { running: boolean; port: number; upstream: string | null }));
  }, []);
  if (!status) return <p className="meta">…</p>;
  if (!status.running) {
    return <p className="meta">Proxy desactivado (define SEASI_MCP_UPSTREAM + credenciales MCP_* en el Vault para activarlo). Los agentes hablarán solo con 127.0.0.1 cuando esté activo.</p>;
  }
  return (
    <p className="meta">
      <span className="status-dot on" /> Activo en <span className="mono">127.0.0.1:{status.port}</span> → <span className="mono">{status.upstream}</span>. Tokens OAuth viven solo en el proceso del proxy (vault), jamás en prompts ni en la UI.
    </p>
  );
}

// ------------------------------------------------------------------- brain

function BrainView({ onDelegate }: { onDelegate: (text: string) => void }): JSX.Element {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [boardCards, setBoardCards] = useState<BoardCard[]>([]);

  const reload = useCallback(() => {
    if (!bridge) return;
    bridge.shell.brainList().then((files) => {
      const acc: Record<string, string> = {};
      void Promise.all(files.map(async (f) => { acc[f] = await bridge.shell.brainRead(f); }))
        .then(() => setNotes({ ...acc }));
    }).catch(() => undefined);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const roadmap = Object.entries(notes).find(([name]) => name.toLowerCase().includes("roadmap"));
    setBoardCards(roadmap ? parseRoadmapBoard(roadmap[1]) : []);
  }, [notes]);

  const graph = useMemo(() => buildGraph(notes), [notes]);
  const totalLinks = useMemo(
    () => Object.values(notes).reduce((n, md) => n + extractWikilinks(md).length, 0),
    [notes],
  );

  const open = async (name: string) => {
    if (!bridge) return;
    setSelected(name);
    setDraft(await bridge.shell.brainRead(name));
  };
  const save = async () => {
    if (!bridge || !selected) return;
    await bridge.shell.brainWrite(selected, draft);
    reload();
  };

  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((n, i) => {
      const ring = i % 3;
      const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      pos.set(n.id, {
        x: 480 + Math.cos(angle) * (120 + ring * 60),
        y: 170 + Math.sin(angle) * (90 + ring * 45),
      });
    });
    return pos;
  }, [graph]);

  return (
    <div>
      <div className="card">
        <h3>Brain de la oficina — {graph.nodes.length} notas · {graph.edges.length} enlaces · {graph.orphans.length} huérfanas · {totalLinks} wikilinks</h3>
        <svg className="graph" viewBox="0 0 960 340">
          {graph.edges.map(([a, b]) => {
            const pa = positions.get(a); const pb = positions.get(b);
            if (!pa || !pb) return null;
            return <line key={`${a}->${b}`} className="edge" x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />;
          })}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id)!;
            return (
              <g key={n.id} onClick={() => void open(n.id)} style={{ cursor: "pointer" }}>
                <circle className="node" cx={p.x} cy={p.y} r={Math.min(18, 8 + n.links.length * 2)} />
                <text className="node-label" x={p.x - 28} y={p.y + 26}>{n.id.replace(/\.md$/, "")}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="card">
        <h3>Roadmap board</h3>
        <div className="board">
          {(["todo", "doing", "blocked", "done"] as const).map((col) => (
            <div className="col" key={col}>
              <h4>{col}<span>{boardCards.filter((c) => c.column === col).length}</span></h4>
              {boardCards.filter((c) => c.column === col).map((c) => (
                <div key={c.id} className={`card-mini ${c.status}`}>
                  {c.title}
                  <button
                    className="delegate"
                    title="encargar a un agente (rellena el composer del Chat)"
                    onClick={() => onDelegate(`Encargo desde el Brain (${col}): ${c.title}`)}
                  >→ agente</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Notas {selected ? `· editando ${selected}` : "· selecciona una en el grafo"}</h3>
        <textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!selected} />
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button className="primary" disabled={!selected} onClick={() => void save()}>Guardar nota</button>
          <button className="ghost" onClick={() => { setSelected(null); setDraft(""); }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- vault

function VaultView(): JSX.Element {
  const [items, setItems] = useState<{ name: string; set: boolean }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const reload = useCallback(() => {
    bridge?.shell.vaultList().then(setItems).catch(() => undefined);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    if (!bridge || !editing) return;
    await bridge.shell.vaultSet(editing, value);
    setValue(""); setEditing(null); reload();
  };

  return (
    <div>
      <div className="card">
        <h3>Vault de la oficina</h3>
        <p className="meta">Los valores se cifran con el Keychain del sistema (safeStorage) y SOLO se inyectan como variables de entorno a los procesos del kernel. Nunca viajan al modelo ni a esta interfaz.</p>
      </div>
      <div className="vault-grid">
        {items.map((it) => (
          <div key={it.name} className="card vault-item">
            <span>
              <span className={`status-dot ${it.set ? "on" : "off"}`} />
              <span className="mono">{it.name}</span>
            </span>
            {editing === it.name ? (
              <span style={{ display: "flex", gap: 6 }}>
                <input type="password" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 130 }} />
                <button className="ok" onClick={() => void save()}>✓</button>
                <button className="ghost" onClick={() => { setEditing(null); setValue(""); }}>×</button>
              </span>
            ) : (
              <span style={{ display: "flex", gap: 6 }}>
                <button className="ghost" onClick={() => { setEditing(it.name); setValue(""); }}>Ajustar</button>
                {it.set && <button className="danger" onClick={() => { void bridge?.shell.vaultDelete(it.name).then(reload); }}>Borrar</button>}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- system

function SystemView(props: { onTenantLoaded: (c: TenantConfig) => void }): JSX.Element {
  const [status, setStatus] = useState<string>("—");
  const [backups, setBackups] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const reloadBackups = useCallback(() => {
    bridge?.shell.backupList().then(setBackups).catch(() => undefined);
  }, []);
  useEffect(() => { reloadBackups(); }, [reloadBackups]);

  const checkUpdate = async () => {
    const res = (await bridge?.shell.updateCheck()) as { status: string; version?: string; reason?: string } | undefined;
    if (!res) { setStatus("bridge no disponible"); return; }
    if (res.status === "up-to-date") setStatus("✓ actualizado");
    else if (res.status === "available") setStatus(`⬆ disponible: ${res.version}`);
    else if (res.status === "not-configured") setStatus("canal de updates no configurado (fase interna)");
    else setStatus(`✗ ${res.reason}`);
  };

  return (
    <div>
      <div className="card">
        <h3>Actualizaciones firmadas</h3>
        <p className="meta">Feed privado + manifest ed25519 + anti-downgrade. Estado: {status}</p>
        <button className="ghost" onClick={() => void checkUpdate()}>Comprobar ahora</button>
      </div>
      <div className="card">
        <h3>Backups locales (ancla de hashes)</h3>
        <button className="primary" onClick={() => { void bridge?.shell.backupCreate().then(() => { setMsg("backup creado"); reloadBackups(); }); }}>Crear backup ahora</button>
        {msg && <p className="meta">{msg}</p>}
        <div style={{ marginTop: 10 }}>
          {backups.map((b) => (
            <div key={b} className="mono" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span>{b}</span>
              <button className="ghost" onClick={() => { void bridge?.shell.backupVerify(b).then(() => setMsg(`✓ ${b} verificado`)).catch((e: unknown) => setMsg(`✗ ${b}: ${String(e)}`)); }}>Verificar</button>
            </div>
          ))}
          {backups.length === 0 && <p className="meta">sin backups aún</p>}
        </div>
      </div>
      <div className="card">
        <h3>Diagnóstico (local, sin telemetría)</h3>
        <p className="meta">Exporta el ledger a una carpeta que TÚ eliges. Nada sale de esta máquina sin tu acción.</p>
        <button className="ghost" onClick={() => { void bridge?.shell.diagnosticsExport().then((r) => setMsg(r.exported ? `exportado a ${r.path}` : "export cancelado")); }}>Exportar paquete</button>
      </div>
      <div className="card">
        <h3>White-label (tenant.json)</h3>
        <p className="meta">Marca y gobierno se configuran en tenant.json. La marca recolorea SOLO --brand-*; los tokens de confianza (violeta, ok/warn/danger) son constantes del producto.</p>
        <button className="ghost" onClick={() => { void bridge?.shell.branding().then((b) => props.onTenantLoaded(b as TenantConfig)); }}>Recargar branding</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- oficina

const fmtTime = (iso: string): string => fmtClock(iso);

const fmtDur = (ms: number): string => {
  const totalMin = Math.floor(ms / 60000);
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
};

const slug = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `tarea-${Date.now()}`;

type RelayInfo = {
  configured: boolean;
  status: "off" | "connecting" | "online";
  url: string | null;
  roster: { persona: string; since: string }[];
};

function OficinaView(): JSX.Element {
  const [persona, setPersona] = useState<string>(() => localStorage.getItem("oficina.persona") ?? "kenyi");
  const [state, setState] = useState<OficinaState | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; events: number; error?: string } | null>(null);
  const [relay, setRelay] = useState<RelayInfo | null>(null);
  const [nota, setNota] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskArea, setTaskArea] = useState("");
  const [taskPrio, setTaskPrio] = useState<"low" | "normal" | "high">("normal");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    bridge?.shell.oficinaState(persona).then(setState).catch((e: unknown) => setErr(String(e)));
    bridge?.shell.oficinaVerify().then(setChain).catch(() => undefined);
  }, [persona]);

  useEffect(() => {
    refresh();
    if (!bridge) return;
    return bridge.shell.onOficinaEvent((payload) => {
      if (payload.kind === "roster") {
        setRelay((prev) => (prev ? { ...prev, roster: payload.online ?? [] } : prev));
      } else if (payload.kind === "status") {
        setRelay((prev) => (prev ? { ...prev, status: (payload.status as RelayInfo["status"]) ?? prev.status } : prev));
      } else {
        refresh();
      }
    });
  }, [refresh]);

  // presencia: identificar a la persona que mira + cargar estado del relay
  useEffect(() => {
    void bridge?.shell.oficinaIdentify(persona);
    bridge?.shell.relayStatus().then(setRelay).catch(() => undefined);
  }, [persona]);

  useEffect(() => {
    localStorage.setItem("oficina.persona", persona);
  }, [persona]);

  const act = async (type: string, payload: unknown): Promise<void> => {
    setErr(null);
    const r = await bridge?.shell.oficinaAppend(type, persona, payload);
    if (r && !r.ok) setErr(`${r.reason}: ${r.message}`);
    refresh();
  };

  const clock = state?.clock;
  const tasks = state?.tasks ?? [];
  const cols: ["todo" | "doing" | "done", string][] = [["todo", "Por hacer"], ["doing", "En curso"], ["done", "Hecho"]];

  return (
    <div className="oficina">
      {err && <div className="banner err">{err}</div>}

      <div className="card oficina-clock">
        <div className="field" style={{ width: 160 }}>
          <label>Persona</label>
          <input value={persona} onChange={(e) => setPersona(e.target.value)} />
        </div>
        <div className="clock-time">
          <span className={`dot ${clock?.in ? "" : "off"}`} />
          {clock?.in
            ? <>fichado desde <strong className="mono">{clock.since ? fmtTime(clock.since) : "—"}</strong> · hoy <strong className="mono">{fmtDur(clock.todayMs)}</strong></>
            : <>sin fichar · hoy <strong className="mono">{fmtDur(clock?.todayMs ?? 0)}</strong></>}
        </div>
        <div className="spacer" />
        <span
          className="pill"
          title={relay?.url ?? "sin relay configurado (modo local)"}
        >
          <span
            className={`dot ${relay?.status === "online" ? "" : relay?.status === "connecting" ? "warn" : "off"}`}
          />
          {relay?.configured ? `relay ${relay.status}` : "local"}
        </span>
        <button
          className={clock?.in ? "ghost" : "primary"}
          onClick={() => void act(clock?.in ? "clock.out" : "clock.in", { persona })}
        >
          {clock?.in ? "Fichar salida" : "Fichar entrada"}
        </button>
        <span className="pill" title={chain?.error ?? "cadena sha256 verificada"}>
          {chain?.ok ? `cadena ✓ · ${chain.events} ev.` : `cadena ✗`}
        </span>
      </div>

      <div className="card oficina-roster">
        <div>
          <span className="kicker">En línea</span>
          <div className="roster-row">
            {(relay?.roster ?? []).length === 0 && (
              <span className="meta">nadie más conectado{relay?.configured ? "" : " (sin relay)"}</span>
            )}
            {(relay?.roster ?? []).map((p) => (
              <span key={p.persona} className={`pill persona ${p.persona === persona ? "me" : ""}`}>
                <span className="dot" />{p.persona}
              </span>
            ))}
          </div>
        </div>
        <div>
          <span className="kicker">Fichados hoy</span>
          <div className="roster-row">
            {(state?.openClocks ?? []).length === 0 && <span className="meta">nadie con jornada abierta</span>}
            {(state?.openClocks ?? []).map((c) => (
              <span key={c.persona} className="pill persona working">
                <span className="dot" />{c.persona} <span className="mono">{fmtTime(c.since)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="oficina-grid">
        <div className="card">
          <p className="kicker">El Diario — hoy</p>
          <div className="diary">
            {(state?.diary ?? []).length === 0 && <div className="empty">Todavía no ha pasado nada hoy.</div>}
            {[...(state?.diary ?? [])].reverse().map((e) => (
              <div key={e.seq} className={`diary-row t-${e.type.replace(".", "-")}`}>
                <span className="mono ts">{fmtTime(e.ts)}</span>
                <span className="who">{e.actor}</span>
                <span className="what">{e.text}</span>
              </div>
            ))}
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>Nota rápida (queda en el diario)</label>
              <input
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nota.trim()) { void act("note", { persona, text: nota.trim() }); setNota(""); }
                }}
                placeholder="¿Qué está pasando? Enter para anotar."
              />
            </div>
          </div>
        </div>

        <div className="card">
          <p className="kicker">Tareas del despacho</p>
          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>Nueva tarea</label>
              <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="p.ej. Revisar 210 LEEFFLANG" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Área</label>
              <input value={taskArea} onChange={(e) => setTaskArea(e.target.value)} placeholder="fiscal" />
            </div>
            <div className="field" style={{ width: 110 }}>
              <label>Prioridad</label>
              <select value={taskPrio} onChange={(e) => setTaskPrio(e.target.value as "low" | "normal" | "high")}>
                <option value="low">baja</option>
                <option value="normal">normal</option>
                <option value="high">alta</option>
              </select>
            </div>
            <button
              className="ghost"
              style={{ alignSelf: "flex-end" }}
              onClick={() => {
                if (!taskTitle.trim()) return;
                void act("task.created", {
                  id: slug(taskTitle),
                  title: taskTitle.trim(),
                  ...(taskArea.trim() ? { area: taskArea.trim() } : {}),
                  priority: taskPrio,
                });
                setTaskTitle("");
              }}
            >
              Crear
            </button>
          </div>
          <div className="board">
            {cols.map(([col, label]) => (
              <div key={col} className="board-col">
                <div className="board-head">{label} <span className="n">{tasks.filter((t) => t.status === col).length}</span></div>
                {tasks.filter((t) => t.status === col).map((t) => (
                  <div key={t.id} className={`task p-${t.priority ?? "normal"}`}>
                    <div className="task-title">{t.title}</div>
                    {t.area && <span className="chip">{t.area}</span>}
                    <div className="task-actions">
                      {cols.filter(([c]) => c !== col).map(([c, l]) => (
                        <button key={c} className="ghost mini" onClick={() => void act("task.moved", { id: t.id, to: c })}>
                          → {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
