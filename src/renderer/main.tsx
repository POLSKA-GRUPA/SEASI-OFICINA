import { createRoot } from "react-dom/client";
import { StrictMode, useEffect, useState } from "react";

type ApiVersion = {
  kernel_version: string;
  adapters: string[];
};

function App(): JSX.Element {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const seasi = (window as unknown as { seasi?: {
      call: (m: string) => Promise<ApiVersion>;
    } }).seasi;
    if (!seasi) {
      setError("puente preload no disponible");
      return;
    }
    seasi
      .call("seasi.version")
      .then((v) => setVersion(`${v.kernel_version} · adaptadores: ${v.adapters.join(", ")}`))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>SEASI Despacho</h1>
      <p>Shell v0 — kernel {version ?? "…"}</p>
      {error ? <p style={{ color: "crimson" }}>error: {error}</p> : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
