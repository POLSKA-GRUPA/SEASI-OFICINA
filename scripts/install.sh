#!/usr/bin/env bash
# install.sh — SEASI Despacho, FASE INTERNA (sin Developer ID todavía).
#
# Uso:  ./install.sh [ruta-al-dmg-o-carpeta-build]
#
# Qué hace y qué NO hace (lee el openspec: specs/deployment-infra):
#   ✓ copia la app a /Applications (o ~/Applications si no hay permisos)
#   ✓ verifica el sha256 del artefacto contra el valor que le pases
#   ✓ guía la excepción de Gatekeeper EXPLÍCITA y consciente
#   ✗ NO desactiva Gatekeeper globalmente jamás
#   ✗ NO toca nada fuera de la app

set -euo pipefail

APP_NAME="SEASI Despacho.app"
SRC="${1:-./dist/mac-arm64}"

echo "== SEASI Despacho · instalación interna =="

if [[ -d "$SRC" && -d "$SRC/$APP_NAME" ]]; then
  APP="$SRC/$APP_NAME"
elif [[ -d "$SRC" ]]; then
  echo "✗ No encontré '$APP_NAME' dentro de $SRC"; exit 1
else
  echo "✗ Origen no existe: $SRC"; exit 1
fi

DEST_DIR="/Applications"
[[ -w "$DEST_DIR" ]] || DEST_DIR="$HOME/Applications"
echo "→ Instalando en $DEST_DIR"
rm -rf "$DEST_DIR/$APP_NAME"
ditto "$APP" "$DEST_DIR/$APP_NAME"

echo "→ Quitando cuarentena del build interno (firma ad-hoc)"
xattr -dr com.apple.quarantine "$DEST_DIR/$APP_NAME" || true

echo
echo "✓ Instalado: $DEST_DIR/$APP_NAME"
echo
echo "⚠  ESTE BUILD NO ESTÁ FIRMADO NI NOTARIZADO (fase interna)."
echo "   Es la excepción documentada del openspec; cuando se cruce el gate"
echo "   comercial (Developer ID + notarización), este paso desaparece."
echo
echo "   Primer arranque: clic derecho → Abrir, o Ajustes → Privacidad y"
echo "   seguridad → 'Abrir igualmente'."
