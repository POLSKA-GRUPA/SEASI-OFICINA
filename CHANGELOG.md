# Changelog — SEASI Oficina

Formato: versiones semver. El "interno" indica fase de despliegue (ver DEPLOYMENT.md).

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
