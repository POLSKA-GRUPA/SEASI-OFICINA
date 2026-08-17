/**
 * Preload: the ONLY bridge between the renderer and the kernel.
 * Exposes a single namespaced object with one method — easy to audit.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("seasi", {
  version: "0.1.0",
  call: (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("seasi:rpc", method, params),
});

export type SeasiBridge = {
  version: string;
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};
