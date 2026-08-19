# Despliegue — SEASI Oficina

> Fuente de verdad de fases: `SEASI-CORE/openspec/changes/sea-sic-core-v0/specs/deployment-infra/spec.md`

## Fase INTERNA (vigente) — coste 0 €

Todo lo de esta fase está pensado para PGK (cliente cero) sin pagar firmas todavía.

### Build local

```bash
npm run contracts        # regenera zod desde ../SEASI-CORE/schemas/v1
npm run typecheck && npm test
npm run build            # out/main + out/preload + out/renderer
# DMG empaquetado (cuando toque): electron-builder — NO todavía, primero gate comercial
```

Arranque en desarrollo (requiere binario real de Electron):

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD= npm install   # (una vez, para tener el binario)
SEASI_CORE_DIR=../SEASI-CORE npm run dev
```

### Instalación interna (sin firma)

```bash
bash scripts/install.sh ./dist/mac-arm64
```

El script: copia con `ditto`, quita cuarentena del build interno y **documenta la
excepción de Gatekeeper** (clic derecho → Abrir). Nunca toca ajustes globales.

### Canal de updates privado (firmado ed25519)

1. Generar el par de claves UNA vez (la privada jamás entra al repo):

```bash
node scripts/gen-keys.mjs ./keys
cp keys/update-public.pem "$HOME/Library/Application Support/La Oficina/update-public.pem"
# (datos previos al rename: la carpeta antigua era "SEASI Despacho" — si existía, muévela a "La Oficina")
```

2. Firmar cada release (el feed es un JSON publicado en GitHub Release privado / R2):

```bash
node scripts/sign-update.mjs \
  --artifact dist/La-Oficina-0.2.0.dmg \
  --version 0.2.0 --channel pgk-internal \
  --key keys/update-private.pem --out dist/feed.json
```

3. La app (pestaña Sistema) comprueba el feed con `SEASI_UPDATE_FEED=<url>`:
   verifica firma ed25519 (clave pública embebida), rechaza downgrades,
   y tras descargar verifica el sha256 del artefacto. La aplicación del
   paquete es un paso manual explícito del usuario en v0 (nunca silencioso).

### Backups locales

Pestaña Sistema → «Crear backup ahora» copia ledger.db (+wal/+shm), brain/
y tenant.json a `backups/<id>/` con `manifest.json` de hashes. «Verificar»
re-hashea todo (ancla que detecta lo que la cadena de eventos no puede ver:
pérdida de cola). Restauración: `restoreBackup` (mismo dominio, testeado).

### Diagnóstico sin telemetría

Pestaña Sistema → «Exportar paquete»: ledger local + README a una carpeta que
elige el usuario. Nada sale de la máquina automáticamente.

## Fase COMERCIAL (gate explícito — NO cruzado aún)

**El gate es ejecutable**: `npm run gate:commercial` (salida PASS/FAIL, exit≠0 si falta algo).

Estado actual de este repo (fase interna): 3 FAIL — exactamente los tres requisitos de pago:

- [ ] Apple Developer Program (99 €/año): Developer ID + notarización stapled
- [ ] Firma Windows: Azure Trusted Signing (~10 €/mes)
- [ ] (implícito en los dos anteriores) credenciales en el entorno

Ya listos y verdes sin coste:

- [x] CI matrix macos-latest + windows-latest (`.github/workflows/ci.yml`)
- [x] electron-builder.yml (mac dmg arm64 + win nsis x64, hardenedRuntime, entitlements)
- [x] Claves ed25519 de canal (`keys/`, privada fuera del repo)
- [x] Entitlements firmados por inquilino con **rechazo cross-tenant** (`domains/entitlement` + tests de forja/expiración/cruce)
- [x] Superficie IPC auditada en CI

Mientras el gate no esté todo en verde: **ninguna instalación fuera de PGK**.
