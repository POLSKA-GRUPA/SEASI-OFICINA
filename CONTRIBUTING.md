# CONTRIBUTING — SEASI Despacho

## Reglas de oro (no negociables)

1. **`src/contracts/gen/` es generado.** Nunca se edita a mano: `npm run contracts`
   regenera desde `../SEASI-CORE/schemas/v1`. Cambiar un contrato = cambiar el
   pydantic del kernel, exportar, regenerar. El CI lo garantiza (drift = build rojo).
2. **Un solo canal IPC de kernel** (`seasi:rpc`) + canales `shell:*` AUDITADOS.
   Todo canal nuevo se declara en `scripts/audit-ipc.mjs` en el MISMO PR (el CI
   falla si no).
3. **Los secretos jamás cruzan la IPC.** El renderer ve nombres/presencia; los
   valores viven en el vault (safeStorage) y salen solo como env de procesos.
4. **Fail-closed por defecto.** Input del renderer se valida SIEMPRE (regex
   estrictos en brain/backup); respuestas del kernel se validan con zod SIEMPRE.
5. **Screaming architecture.** Dominio nuevo → `src/domains/<dominio>/` con sus
   tests. Nada de carpetas genéricas `/utils` donde esconder lógica.

## Flujo

```bash
npm run contracts:check   # SSOT gate
npm run typecheck && npm test   # 69+ tests (incluye kernel real vía uv)
npm run audit:ipc         # superficie IPC
npm run gate:commercial   # estado del gate (fase interna: 3 FAIL de pago = correcto)
```

- Branches: `feat/<tema>` desde main. Commits: `feat(shell): …` / `fix(kernel): …`
- Un PR = una cosa. Si toca kernel Y shell: dos PRs enlazados (dos repos).
- Tests primero en dominios nuevos (TDD): la batería dura existente es el listón.

## Decisiones ya tomadas (no reabrir sin ADR)

- Electron + TS (no Tauri/Rust) — ver SEASI-CORE/openspec sea-sic-core-v0/design.md.
- JSON-RPC estructurado como canal de negocio; PTY solo visual (nunca protocolo).
- División SSOT: **zod valida forma; pydantic + scope_guard validan semántica.**
- Sin telemetría. Diagnóstico = paquete local que exporta el usuario.
