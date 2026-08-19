# Seguridad — SEASI Oficina

## Modelo en una línea
Shell Electron aislado (sandbox+contextIsolation) → un canal IPC auditado →
JSON-RPC a un kernel local que gobierna efectos con HITL y ledger encadenado.
Datos 100% locales. Sin telemetría.

## Superficies y defensas

| Superficie | Defensa |
|---|---|
| Renderer (web) | sandbox ON, contextIsolation ON, nodeIntegration OFF, CSP estricta, `setWindowOpenHandler` deny, bridge único `window.seasi` |
| IPC | 14 canales AUDITADOS en CI (`audit-ipc.mjs`); inputs del renderer validados con regex estrictos (nombres .md, ids de backup) |
| Secretos | Vault safeStorage (Keychain); NUNCA cruzan la IPC ni el contexto del modelo; inyección por env a procesos |
| OAuth MCP | Proxy loopback con tokens solo en el proceso; refresh proactivo; fail-closed 503 |
| Efectos del agente | HITL obligatorio (pausas persistidas + ApprovalIntent sellado); scope de tenant congelado por código (scope_guard) |
| Evidencia | Ledger append-only con hash encadenado + ancla de hashes en backups |
| Updates | Manifest ed25519 firmado + clave pública embebida + anti-downgrade + sha256 del artefacto |
| Inquilinos | Entitlements firmados; rechazo cross-tenant por diseño |
| Diagnóstico | Paquete LOCAL exportado por el usuario; nada sale solo |

## Reporte de vulnerabilidades
Privado, vía el equipo SEA-SIC. No abrir issues públicos de seguridad.
Thor: ver `docs/DEPLOYMENT.md` para el gate comercial antes de exponer nada.

## Lo que NO es
- No es sandbox de OS para código arbitrario del agente (esa es la frontera del
  harness del kernel, no del shell).
- Fase interna = builds sin firma/notarización: solo PGK, excepción documentada.
