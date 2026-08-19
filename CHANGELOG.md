# Changelog — SEASI Oficina

Formato: versiones semver. El "interno" indica fase de despliegue (ver DEPLOYMENT.md).

## [0.2.0] — interno (2026-08-19)

### Añadido — La Oficina v0 (diario local)
- Dominio **`oficina/`**: event store humano local `oficina.jsonl` (JSONL append-only
  con hash-chain sha256): `clock.in/out`, `task.created/moved`, `note`. Un solo log
  = fichaje auditable + diario del día + tareas; las vistas son proyecciones.
- Pestaña **Oficina** (home por defecto): reloj de fichaje con total del día,
  El Diario (feed de hoy, más nuevo arriba), nota rápida (Enter) y board de tareas
  todo/doing/done con prioridades. La pestaña de sesiones pasa a llamarse "Sesiones".
- IPC `shell:oficina:{state,append,verify}` + broadcast `shell:oficina:event`
  (auditados; superficie 17 canales / 2 eventos / 18 métodos).
- Verificación de cadena en vivo (pill "cadena ✓ · N ev.") y reglas fail-closed
  (fichaje doble, out sin in, tarea duplicada/desconocida, payload estricto).
- Renombrado del producto: SEASI Despacho → **SEASI Oficina / «La Oficina»**
  (repo, package `seasi-oficina`, appId `com.seasi.oficina`, artefactos `La-Oficina-*`).
- CI verde cross-platform: digests canónicos LF (Windows + autocrlf), `uv` en
  runners con pre-warm del venv del kernel.

## [0.1.1] — interno (2026-08-17)

### Añadido
- Streaming en vivo de sesiones: notificaciones `seasi.session.event` del kernel
  retransmitidas a la UI en tiempo real (panel "Streaming en vivo" en Oficina).
- Pestaña **Uso**: turnos + tokens in/out por sesión (`seasi.usage.summary`).
- Dominio **mcp-proxy**: OAuth local en 127.0.0.1 con refresh proactivo (skew 60s),
  retry único en 401, fail-closed 503 y cero tokens en logs/respuestas.
- Dominio **entitlement**: paquetes firmados ed25519 por inquilino con rechazo
  cross-tenant, de canal y expiración.
- **Gate comercial scriptable** (`npm run gate:commercial`) + `electron-builder.yml`
  + CI matrix mac/win.
- LICENSE propietaria, CONTRIBUTING, SECURITY, CHANGELOG, logo e icono.

## [0.1.0] — interno (2026-08-17)

### Añadido
- Kernel channel JSON-RPC (`seasi:rpc`) con 6 métodos + dominios:
  kernel-bridge tipado, brain (wikilinks/grafo/board), vault (safeStorage +
  env-injection), backup (ancla de hashes + restauración), updater (feed
  ed25519 + anti-downgrade), branding (tenant.json 3 planos).
- 54 tests duros (forjas ed25519, corrupción de backups, no-fuga de vault,
  integración real contra `uv run python -m seasi_core.rpc`).
- Auditoría automática de superficie IPC (`audit-ipc.mjs`) como gate de CI.
