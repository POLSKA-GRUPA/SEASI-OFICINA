import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  collectDescendants,
  parseProcessTable,
  terminateProcessTree,
  type ProcessTableRow,
} from "../src/domains/kernel-bridge/process-termination";

describe("parseProcessTable", () => {
  it("parsea la salida de ps con columnas pid/ppid/pgid", () => {
    const out = "  100   1   100\n  200 100   100\n basura\n  300 200   100\n";
    expect(parseProcessTable(out)).toEqual([
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 100 },
    ]);
  });
});

describe("collectDescendants", () => {
  const table: ProcessTableRow[] = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 20, ppid: 10, pgid: 10 },
    { pid: 30, ppid: 20, pgid: 10 },
    { pid: 40, ppid: 1, pgid: 40 }, // no relacionado
  ];

  it("encuentra descendientes transitivos sin incluir el root", () => {
    expect(collectDescendants(table, 10).map((r) => r.pid)).toEqual([20, 30]);
  });

  it("devuelve vacío si el root no tiene hijos", () => {
    expect(collectDescendants(table, 40)).toEqual([]);
  });
});

describe("terminateProcessTree (POSIX, señales inyectadas)", () => {
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly("SIGTERM a root+descendientes; SIGKILL solo a supervivientes con la misma identidad", async () => {
    const before: ProcessTableRow[] = [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 20, ppid: 10, pgid: 10 },
      { pid: 30, ppid: 20, pgid: 10 },
    ];
    // 20 murió; 30 sigue con la misma identidad; 10 fue REUTILIZADO (otro ppid/pgid)
    const after: ProcessTableRow[] = [
      { pid: 10, ppid: 999, pgid: 999 },
      { pid: 30, ppid: 20, pgid: 10 },
    ];
    const tables = [before, after];
    const sent: [number, string][] = [];
    await terminateProcessTree(10, {
      readTable: () => Promise.resolve(tables.shift() ?? []),
      sendSignal: (pid, signal) => sent.push([pid, signal]),
      wait: () => Promise.resolve(),
    });
    expect(sent).toEqual([
      [10, "SIGTERM"],
      [20, "SIGTERM"],
      [30, "SIGTERM"],
      [30, "SIGKILL"], // 10 reutilizado NO se toca; 20 ya murió
    ]);
  });

  posixOnly("si el snapshot falla, degrada a señalar solo el root", async () => {
    const sent: [number, string][] = [];
    await terminateProcessTree(42, {
      readTable: () => Promise.reject(new Error("ps no disponible")),
      sendSignal: (pid, signal) => sent.push([pid, signal]),
      wait: () => Promise.resolve(),
    });
    expect(sent).toEqual([
      [42, "SIGTERM"],
      [42, "SIGKILL"],
    ]);
  });

  posixOnly("mata un árbol real sh → sleep (integración)", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & wait"]);
    const rootPid = child.pid!;
    await new Promise((resolve) => setTimeout(resolve, 300)); // dar tiempo a que nazca el sleep
    await terminateProcessTree(rootPid, { graceMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(rootPid, 0)).toThrow(); // ESRCH: ya no existe
  }, 15_000);
});
