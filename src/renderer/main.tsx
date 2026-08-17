import { createRoot } from "react-dom/client";
import { StrictMode, useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { KernelClient, KernelError, type AgentSessionLike, type HitlPauseLike, type LedgerEventLike, type UsageRow } from "../domains/kernel-bridge/client";
import { buildGraph, extractWikilinks, parseRoadmapBoard, type BoardCard } from "../domains/brain/parser";
import type { TenantConfig } from "../domains/branding/config";
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
  };
};

const bridge = (window as unknown as { seasi?: Bridge }).seasi;
const kernel = new KernelClient((m, p) => {
  if (!bridge) return Promise.reject(new Error("bridge preload no disponible"));
  return bridge.call(m, p);
});

function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="112" fill="#17181b" />
      <path d="M256 76 L404 162 L404 350 L256 436 L108 350 L108 162 Z" fill="none"
        stroke="url(#brand-g)" strokeWidth="26" strokeLinejoin="round" />
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-primary)" />
          <stop offset="1" stopColor="var(--brand-accent)" />
        </linearGradient>
      </defs>
      <g stroke="#74767c" strokeWidth="14" strokeLinecap="round">
        <line x1="256" y1="170" x2="200" y2="300" /><line x1="256" y1="170" x2="312" y2="300" />
        <line x1="200" y1="300" x2="256" y2="350" /><line x1="312" y1="300" x2="256" y2="350" />
      </g>
      <circle cx="256" cy="170" r="34" fill="var(--brand-primary)" />
      <circle cx="256" cy="350" r="38" fill="var(--brand-accent)" />
    </svg>
  );
}

type Tab = "rail" | "hitl" | "uso" | "brain" | "vault" | "sistema";

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("rail");
  const [tenant, setTenant] = useState<TenantConfig | null>(null);
  const [kernelVersion, setKernelVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) { setError("preload no disponible (¿ejecución fuera de Electron?)"); return; }
    bridge.shell.branding().then((b) => setTenant(b as TenantConfig)).catch((e: unknown) => setError(String(e)));
    kernel.version().then((v) => setKernelVersion(v.kernel_version)).catch(() => setKernelVersion("kernel no disponible"));
  }, []);

  const brandName = tenant?.branding.name ?? "SEASI";
  useEffect(() => {
    if (tenant?.branding.colors) {
      document.documentElement.style.setProperty("--brand-primary", tenant.branding.colors.primary);
      if (tenant.branding.colors.accent) document.documentElement.style.setProperty("--brand-accent", tenant.branding.colors.accent);
      if (tenant.branding.colors.bg) document.documentElement.style.setProperty("--brand-bg", tenant.branding.colors.bg);
    }
  }, [tenant]);

  return (
    <>
      <aside className="rail">
        <RailPanel />
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="brand">
            <BrandMark />
            <span className="word">{brandName.split(" — ")[0]} <em>Despacho</em></span>
          </div>
          <span className="pill"><span className={`dot ${kernelVersion ? "" : "off"}`} />{kernelVersion ? `kernel ${kernelVersion}` : "kernel…"}</span>
          <span className="pill">shell v{bridge?.version ?? "?"}</span>
          <div className="spacer" />
          <span className="pill">{tenant?.tenant_id ?? "…"}</span>
        </header>
        <nav className="tabs">
          {(["rail", "hitl", "uso", "brain", "vault", "sistema"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "rail" ? "Despacho" : t === "hitl" ? "HITL" : t === "uso" ? "Uso" : t === "vault" ? "Vault" : t === "sistema" ? "Sistema" : "Brain"}
            </button>
          ))}
        </nav>
        <section className="view">
          {error && <div className="banner err">{error}</div>}
          {tab === "rail" && <RailView />}
          {tab === "hitl" && <HitlView />}
          {tab === "uso" && <UsageView />}
          {tab === "brain" && <BrainView />}
          {tab === "vault" && <VaultView />}
          {tab === "sistema" && <SystemView onTenantLoaded={setTenant} />}
        </section>
      </main>
    </>
  );
}

// ------------------------------------------------------------------- rail

type SessionRow = AgentSessionLike & { clientLabel: string };

function RailPanel(): JSX.Element {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(() => {
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
    }).catch(() => setSessions([]));
  }, []);

  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t); }, [reload]);

  const grouped = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const list = m.get(s.clientLabel) ?? [];
      list.push(s);
      m.set(s.clientLabel, list);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sessions]);

  return (
    <div className="client-list">
      <h3>Clientes / Sesiones</h3>
      {grouped.length === 0 && <div className="empty">Sin sesiones todavía.<br />Crea la primera en la pestaña Despacho.</div>}
      {grouped.map(([client, rows]) => (
        <div key={client}>
          <div className="client" onClick={() => setSelected(client)}>
            <strong>{client}</strong>
            <span className="nif">{rows.length} ses.</span>
          </div>
          {selected === client &&
            rows.map((r) => (
              <div key={String(r.session_id)} className="client" style={{ paddingLeft: 22 }}>
                <span className="mono">{r.period_ref}</span>
                <span className={`chip state-${r.state}`}>{String(r.state).replace("_", " ")}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function RailView(): JSX.Element {
  const [clientRef, setClientRef] = useState("");
  const [period, setPeriod] = useState("2026T3");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [log, setLog] = useState<LedgerEventLike[]>([]);
  const [prompt, setPrompt] = useState("");
  const [live, setLive] = useState<{ method: string; params: unknown }[]>([]);

  const tailLog = useCallback(() => {
    kernel.eventTail("pgk", 40).then(setLog).catch(() => undefined);
  }, []);

  useEffect(() => { tailLog(); const t = setInterval(tailLog, 4000); return () => clearInterval(t); }, [tailLog]);

  // Streaming en vivo: notificaciones del kernel mientras corre una sesión
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.shell.onSessionEvent((payload) => {
      setLive((prev) => [...prev.slice(-499), payload]);
    });
    return off;
  }, []);

  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const s = await kernel.startSession({ tenant_id: "pgk", client_ref: clientRef || "SIN-NIF", period_ref: period });
      setMsg(`sesión ${String(s.session_id).slice(0, 8)} creada para ${s.client_ref} ${s.period_ref}`);
      tailLog();
    } catch (e) {
      setMsg(e instanceof KernelError ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card">
        <p className="kicker">Nueva sesión</p>
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label>Cliente (NIF/CIF)</label>
            <input value={clientRef} onChange={(e) => setClientRef(e.target.value)} placeholder="B82211806" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Periodo</label>
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026T3" />
          </div>
          <div style={{ alignSelf: "flex-end", paddingBottom: 12 }}>
            <button className="primary" disabled={busy} onClick={() => void start()}>Crear sesión</button>
          </div>
        </div>
        {msg && <p className="meta">{msg}</p>}
      </div>
      <div className="card">
        <p className="kicker">Streaming en vivo</p>
        <div className="log">
          {live.length === 0 && <span>— sin sesión en curso; lanza un run y los eventos llegan aquí en tiempo real —</span>}
          {[...live].slice(-25).reverse().map((n, i) => {
            const ev = (n.params as { event?: { kind?: string; data?: Record<string, unknown> } }) ?? {};
            return (
              <div key={`${i}-${ev.event?.kind}`}>
                <span className={`type kind-${ev.event?.kind ?? ""}`}>{ev.event?.kind ?? n.method}</span>{"  "}
                <span>{new Date().toLocaleTimeString()}</span>{"  "}
                <span>{JSON.stringify(ev.event?.data ?? {}).slice(0, 90)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <p className="kicker">Ledger del kernel</p>
        <div className="log">
          {log.length === 0 && <span className="meta">— vacío —</span>}
          {[...log].reverse().map((e) => (
            <div key={e.event_id}>
              <span className="type">{e.event_type}</span>{" "}
              <span className="mono">{new Date(e.occurred_at).toLocaleTimeString()}</span>{" "}
              <span className="mono">{e.hash.slice(0, 10)}…</span>
            </div>
          ))}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Prompt (envía una tarea al kernel — requiere sesión previa)</label>
          <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="p. ej. clasifica las facturas de 2026T3 de B82211806" />
        </div>
        <button className="ghost" onClick={() => { setPrompt(""); setMsg("run directo deshabilitado hasta elegir sesión (HITL gobierna los efectos)"); }}>Encolar tarea</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- hitl

function HitlView(): JSX.Element {
  const [pending, setPending] = useState<HitlPauseLike[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [actor, setActor] = useState("asesor");

  const reload = useCallback(() => {
    kernel.listPendingHitl("pgk").then(setPending).catch((e: unknown) => setMsg(String(e)));
  }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 4000); return () => clearInterval(t); }, [reload]);

  const decide = async (pause: HitlPauseLike, decision: "approved" | "rejected") => {
    try {
      await kernel.decideHitl({ pause_id: String(pause.pause_id), decision, actor });
      setMsg(`${decision === "approved" ? "✓ aprobado" : "✗ rechazado"} · ${pause.capability_id}`);
      reload();
    } catch (e) {
      setMsg(e instanceof KernelError ? e.message : String(e));
    }
  };

  const newPause = async () => {
    try {
      await kernel.createHitl({
        tenant_id: "pgk",
        session_id: "00000000-0000-4000-8000-000000000001",
        capability_id: "email.send",
        payload_digest: "a".repeat(64),
      });
      reload();
    } catch (e) { setMsg(e instanceof KernelError ? e.message : String(e)); }
  };

  return (
    <div className="hitl-queue">
      <div className="card">
        <h3>Cola de aprobaciones (efectos gated)</h3>
        <p className="meta">Todo efecto externo (AEAT, email, posting) se congela aquí hasta decisión humana. La aprobación sella un intent sobre el digest exacto.</p>
        <div className="field" style={{ maxWidth: 260 }}>
          <label>Actor (quién decide)</label>
          <input value={actor} onChange={(e) => setActor(e.target.value)} />
        </div>
        <button className="ghost" onClick={() => void newPause()}>Simular pausa (filing.submit)</button>
        {msg && <div className="banner ok" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
      {pending.length === 0 && <div className="card"><p className="meta">Sin pausas pendientes.</p></div>}
      {pending.map((p) => (
        <div key={String(p.pause_id)} className="card pause">
          <p className="kicker">Efecto gated</p>
          <h3 className="mono" style={{ fontSize: 14 }}>{p.capability_id}</h3>
          <span className="meta">sesión {String(p.session_id).slice(0, 8)} · expira {new Date(p.expires_at).toLocaleTimeString()}</span>
          <div className="digest mono" style={{ margin: "10px 0" }}>
            <b>digest</b> {p.payload_digest}
          </div>
          <div className="actions">
            <button className="ok" onClick={() => void decide(p, "approved")}>Aprobar</button>
            <button className="danger" onClick={() => void decide(p, "rejected")}>Rechazar</button>
          </div>
        </div>
      ))}
    </div>
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

function BrainView(): JSX.Element {
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
        <h3>Brain del despacho — {graph.nodes.length} notas · {graph.edges.length} enlaces · {graph.orphans.length} huérfanas · {totalLinks} wikilinks</h3>
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
                <div key={c.id} className={`card-mini ${c.status}`}>{c.title}</div>
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
        <h3>Vault del despacho</h3>
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
        <p className="meta">Marca, capacidades y gobierno se configuran en el archivo tenant.json del perfil. Cambia la marca y la UI la aplica al reiniciar.</p>
        <button className="ghost" onClick={() => { void bridge?.shell.branding().then((b) => props.onTenantLoaded(b as TenantConfig)); }}>Recargar branding</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
