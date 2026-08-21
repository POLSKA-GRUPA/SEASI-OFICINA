/**
 * Terminación robusta del árbol de procesos del kernel. El kernel se lanza
 * como `uv run … python -m seasi_core.rpc`: matar solo el PID de `uv` puede
 * dejar el python (y sus hijos) huérfanos escribiendo en el ledger.
 *
 * Estrategia (POSIX): snapshot de la tabla de procesos → descendientes por
 * ppid → SIGTERM → gracia → SIGKILL solo a PIDs que SIGUEN en la tabla con
 * el mismo ppid/pgid (anti-reutilización de PID: nunca se señala un PID
 * viejo a ciegas). En Windows delega en `taskkill /T`.
 *
 * Patrón adaptado de stablyai/orca (src/main/pty-descendant-termination.ts, MIT).
 */
import { execFile } from "node:child_process";

export const KILL_GRACE_MS = 2_000;
export const SNAPSHOT_TIMEOUT_MS = 1_000;
// una tabla de procesos llena puede superar el maxBuffer por defecto de execFile
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type ProcessTableRow = { pid: number; ppid: number; pgid: number };
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;
export type ProcessTableReader = () => Promise<ProcessTableRow[]>;

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

/** Descendientes transitivos de `rootPid` según la tabla (el root no se incluye). */
export function collectDescendants(rows: ProcessTableRow[], rootPid: number): ProcessTableRow[] {
  const byParent = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const out: ProcessTableRow[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

function readProcessTable(): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid="],
      { maxBuffer: PS_MAX_BUFFER_BYTES, timeout: SNAPSHOT_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessTable(stdout));
      },
    );
  });
}

function defaultSignalSender(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: el proceso ya no existe — objetivo cumplido
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function terminateWindowsTree(rootPid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(rootPid), "/T", "/F"], () => resolve());
  });
}

export type TerminateOptions = {
  graceMs?: number;
  readTable?: ProcessTableReader;
  sendSignal?: SignalSender;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Termina `rootPid` y todos sus descendientes. SIGTERM primero (el kernel
 * puede cerrar el ledger limpiamente); tras la gracia, SIGKILL solo a los
 * PIDs que siguen en la tabla con la MISMA identidad (ppid+pgid) que en el
 * snapshot inicial — un PID reutilizado por otro proceso no se toca.
 */
export async function terminateProcessTree(rootPid: number, options: TerminateOptions = {}): Promise<void> {
  if (process.platform === "win32") {
    await terminateWindowsTree(rootPid);
    return;
  }
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const readTable = options.readTable ?? readProcessTable;
  const sendSignal = options.sendSignal ?? defaultSignalSender;
  const wait = options.wait ?? sleep;

  let before: ProcessTableRow[];
  try {
    before = await readTable();
  } catch {
    // sin snapshot no hay identidad verificable: señal solo al root conocido
    sendSignal(rootPid, "SIGTERM");
    await wait(graceMs);
    sendSignal(rootPid, "SIGKILL");
    return;
  }
  const targets = [...collectDescendants(before, rootPid)];
  const rootRow = before.find((row) => row.pid === rootPid);
  if (rootRow) targets.unshift(rootRow);

  for (const row of targets) sendSignal(row.pid, "SIGTERM");
  if (targets.length === 0) return;

  await wait(graceMs);

  let after: ProcessTableRow[];
  try {
    after = await readTable();
  } catch {
    return; // sin re-verificación de identidad no se manda SIGKILL a ciegas
  }
  const alive = new Map(after.map((row) => [row.pid, row]));
  for (const row of targets) {
    const current = alive.get(row.pid);
    if (current && current.ppid === row.ppid && current.pgid === row.pgid) {
      sendSignal(row.pid, "SIGKILL");
    }
  }
}
