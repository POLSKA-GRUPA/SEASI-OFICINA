/**
 * Preload: the ONLY bridge between renderer and main/kernel.
 * One namespaced object; every method is allowlisted here and audited by
 * scripts/audit-ipc.mjs (CI).
 */
import { contextBridge, ipcRenderer } from "electron";

const call = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
  ipcRenderer.invoke("seasi:rpc", method, params);

const shell = {
  vaultList: (): Promise<{ name: string; set: boolean }[]> =>
    ipcRenderer.invoke("shell:vault:list"),
  vaultSet: (name: string, value: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("shell:vault:set", name, value),
  vaultDelete: (name: string): Promise<boolean> =>
    ipcRenderer.invoke("shell:vault:delete", name),
  brainList: (): Promise<string[]> => ipcRenderer.invoke("shell:brain:list"),
  brainRead: (name: string): Promise<string> => ipcRenderer.invoke("shell:brain:read", name),
  brainWrite: (name: string, content: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("shell:brain:write", name, content),
  backupCreate: (): Promise<unknown> => ipcRenderer.invoke("shell:backup:create"),
  backupList: (): Promise<string[]> => ipcRenderer.invoke("shell:backup:list"),
  backupVerify: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("shell:backup:verify", id),
  updateCheck: (): Promise<unknown> => ipcRenderer.invoke("shell:update:check"),
  branding: (): Promise<unknown> => ipcRenderer.invoke("shell:branding:get"),
  mcpStatus: (): Promise<unknown> => ipcRenderer.invoke("shell:mcp:status"),
  onSessionEvent: (cb: (payload: { method: string; params: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { method: string; params: unknown }): void => cb(payload);
    ipcRenderer.on("shell:session:event", listener as never);
    return () => {
      ipcRenderer.removeListener("shell:session:event", listener as never);
    };
  },
  diagnosticsExport: (): Promise<{ exported: boolean; path: string }> =>
    ipcRenderer.invoke("shell:diagnostics:export"),
};

contextBridge.exposeInMainWorld("seasi", { version: "0.1.0", call, shell });

export type SeasiBridge = typeof shell & {
  version: string;
  call: typeof call;
};
