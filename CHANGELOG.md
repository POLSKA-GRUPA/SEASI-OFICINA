# Changelog — SEASI Oficina

Formato: versiones semver. El "interno" indica fase de despliegue (ver DEPLOYMENT.md).

## [0.3.0] — interno (2026-08-19)

### Añadido — tiempo real multi-máquina (relay)
- **Servidor relay** (`relay/server.mjs`, deploy independiente en VPS): salas por
  tenant, auth por token compartido (timing-safe, fail-closed 4401), fan-out de
  eventos, replay de los últimos 50 al conectar, presencia con evicción por TTL,
  `/healthz`. Sin verdad de negocio: la verdad vive en cada cliente.
- **Store v2**: eventos con `uid` + `origin` → merge idempotente entre máquinas
  (el mismo uid jamás se aplica dos veces; dedupe sobrevive reinicios). Los logs
  v1 sin esos campos cargan igual y su cadena sigue verificando.
- **Fichaje por-persona**: varias personas pueden tener jornada abierta a la vez;
  las reglas y la proyección del reloj son por persona, y `openClocks` expone
  quién del despacho está fichado hoy.
- **Cliente relay** en main (backoff exponencial, heartbeat, reconexión,
  publicación de eventos locales, aplicación de remotos) — configuración:
  `tenant.json → relay.url` + `OFICINA_RELAY_TOKEN` en el vault. Sin relay,
  modo 100% local.
- **UI**: pill de estado (`local` / `relay online|connecting|off`), roster En
  línea en vivo y tarjetas Fichados hoy; la persona se identifica con el relay
  (IPC `shell:oficina:identify` + `shell:oficina:relay`, auditados).
- Test E2E de sincronización: dos stores ("dos máquinas") contra el relay real —
  fichaje/nota/tarea de A aparecen y persisten en B; replay no duplica; reglas
  locales intactas; bidireccional.

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
