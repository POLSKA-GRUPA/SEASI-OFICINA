# HANDOFF — SEASI Despacho (pausa por trabajo del owner)

> Fecha: 2026-08-17 ~19:00 · Rama kernel: `feat/sea-sic-core-v0` · Repo shell: `~/SEASI-DESPACHO` (main)

## Estado en una frase

Motor 100% verde (kernel 171 tests + shell 69 tests, SSOT con drift imposible, streaming, HITL, vault, updater ed25519, entitlements, gate comercial scriptable). **La piel es lo único abierto**: mockup v4 aprobado en dirección, implementación real del renderer PENDIENTE.

## Contexto de esta sesión (el "por qué" del diseño)

- Owner rechazó la skin v2 ("admin de los 2000") y luego el mockup v3 ("no está a la altura de Granular").
- **Decisión de diseño cerrada**: mono fino (grises #0c0c0e→#1d1d22) + UN acento violeta `#8b5cf6`. **PROHIBIDO el naranja PGK/Granular** (`#ff5800`, `#e07850`).
- Referencias vivas: **Granular instalada en `/Applications/Granular.app`** (firmada+notarizada, auditada) y **playground `~/Documents/granular-playground`** (repo juguete con `brain/` creado por SU agente — patrón exacto de archivos verificado en disco).
- 14 capturas del análisis: `docs/design-research/` (workspace, sidebar, chat+tarjetas, preview, input, menús).

## ADN de Granular extraído (aplicar en v4 — detalles en Engram #8486, #8492, #8496)

1. **Onboarding 8 pasos**: split-view, estados Ready/needs-setup, CTA único naranja (→ violeta nuestro)
2. **Dock iconos ~54px** + panel jerárquico con **avatares de agentes coloreados + atajos ⌘1-4** + puntos de estado (idle/run/done)
3. **Chat ≠ burbujas**: log de eventos con **tarjetas de acción** (icono + acción mono + resultado + duración + ✓)
4. **Composer**: píldoras modelo/tools/permisos/budget + **barra de contexto de puntos** + "Enter queues your next prompt" (input JAMÁS se bloquea) + botón stop visible
5. **Permisos HITL suyos** (menú capturado): `Auto-allow / Ask first / Plan (read-only)` — mapea 1:1 con nuestro effect_policy
6. **Brain**: `BRAIN.md` portada con wikilinks + roadmap.md kanban **extendido**: columnas `Idea Bank/Backlog/In Progress/Done`, items `- texto · priority: X · area: Y`, cada item enlaza a nota de detalle
7. **Cierre conversacional del agente**: qué hizo → qué NO hizo → siguiente paso propuesto
8. Tokens CSS: Radix Themes (MIT, 173 vars), transiciones `.14s cubic-bezier(.2,0,0,1)`, borders `1px rgba(255,255,255,.1)`

## Mockups (listos para implementar)

- `assets/mockup-v3-mono.png` — 8.5/10 según visión, aprobado en dirección
- `assets/mockup-v4-mono.html` — **el definitivo**: dock + agentes con avatares + tarjetas de acción + composer con píldoras + preview pane + status bar. Ábrelo en Chrome para verlo (es HTML estático real)
- `scripts/capture-mockup.js` — herramienta: `SEASI-DESPACHO/node_modules/.bin/electron scripts/capture-mockup.js <html> <out.png>` (captura mockups con Electron offscreen)

## PENDIENTE (en orden)

1. **[SIGUIENTE] Implementar renderer v4** según `assets/mockup-v4-mono.html`: layout grid dock+agents+chat+right, componentes por dominio, animaciones (glow-pulse run, fade-in tarjetas). Datos reales ya existen: streaming (`seasi.session.event`), usage.summary, hitl.list, event.tail. El kernel NO se toca.
2. Parser brain: añadir columnas `Idea Bank` + metadatos `priority:`/`area:` + notas de detalle por item (extensión compatible del formato actual en `src/domains/brain/parser.ts` + tests)
3. Composer con "Enter queues" + botón stop (requires: cancel en el harness — `ProcessHarness.cancel()` ya existe, falta método RPC `seasi.session.cancel`)
4. Cierre conversacional: convención de último mensaje del agente (qué hizo/no hizo/siguiente) en el adaptador pi
5. Verificación integral final + commits + CHANGELOG 0.2.0

## Reglas de la casa (no renegociables)

- Contratos: pydantic → `tools/export_schemas.py` → `npm run contracts`. Nunca editar `src/contracts/gen/`
- IPC: canal nuevo = declararlo en `scripts/audit-ipc.mjs` en el mismo commit
- Sin telemetría. Vault jamás cruza la IPC
- Colores: mono + `#8b5cf6`. Ni naranja PGK ni azul-GitHub genérico
- Gate comercial (`npm run gate:commercial`): 3 FAIL de pago son CORRECTOS hasta pagar Apple/Azure

## Reanudar rápido

```bash
# shell (UI)
cd ~/SEASI-DESPACHO && npx tsc --noEmit && npx vitest run   # 69 tests
SEASI_CORE_DIR=~/SEASI-CORE npm run dev                     # app de verdad
# kernel
cd ~/SEASI-CORE && uv run pytest                            # 171 tests
# mockup v4 en navegador
open ~/SEASI-DESPACHO/assets/mockup-v4-mono.html
# Granular de referencia (cerrada para liberar RAM)
open -a Granular   # proyecto: granular-playground (NO abrir PGK_Empresa_Autonoma ahí)
```
