# SEASI Despacho

**Shell de escritorio local-first para el kernel [SEASI-CORE](../SEASI-CORE)** — el "despacho fiscal" de SEASI. Electron + TypeScript estricto + React. Cliente cero: PGK.

> Change de origen: `SEASI-CORE/openspec/changes/sea-sic-core-v0/` (proposal, design, specs, tasks). Este repo implementa los bloques 1.5 (lado TS) y 3.x del plan.

## Arquitectura en una línea

```
UI React ──(contextBridge: window.seasi.call)──▶ main Electron ──(JSON-RPC stdio)──▶ uv run python -m seasi_core.rpc
```

- **Un solo canal IPC** (`seasi:rpc`) — superficie auditable.
- **El canal de negocio es JSON-RPC estructurado**; nunca se parsea salida de terminal para extraer estado.
- Los contratos (session, artifact, hitl-pause, shell-api) se **generan** desde `SEASI-CORE/schemas/v1` con los mismos sha256 que verifica el CI del kernel: si algo deriva, falla en ambas repos.

## Reglas del repo

1. `src/contracts/gen/` es **generado** — no se edita a mano (`npm run contracts`).
2. Los dominios van por *screaming architecture*: `src/domains/<dominio>/` (no `/components` genéricos).
3. Seguridad por defecto: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, CSP en el renderer, `setWindowOpenHandler` deny.
4. Sin telemetría. Diagnóstico = paquete local exportado por el usuario.

## Desarrollo

```bash
npm install                # instala deps (ajusta versiones si npm resuelve distinto)
npm run contracts          # regenera contratos desde ../SEASI-CORE (o SEASI_SCHEMAS_DIR=...)
npm run contracts:check    # gate CI: drift imposible
npm run typecheck && npm test
SEASI_CORE_DIR=../SEASI-CORE npm run dev
```

Requisitos: Node 22+, `uv` con SEASI-CORE instalable (`uv run --project ../SEASI-CORE python -m seasi_core.rpc` debe responder).

## Estado (v0.1.0)

- [x] Bootstrap electron-vite + TS strict
- [x] Puente preload mínimo (un objeto, un método)
- [x] Generador de contratos con gate de digests
- [x] Tests de paridad kernel↔shell
- [ ] Rail de despacho, sesiones, cola HITL, vault, brain (bloques 3.3–3.11 del change)

## Despliegue

Fase INTERNA (este repo, hoy): sin firma — `npm run dev` o build local. La fase COMERCIAL (Developer ID, notarización, firma Windows, canales por inquilino) es un **gate explícito** del change: nada externo a PGK se despliega antes de cruzarlo.
