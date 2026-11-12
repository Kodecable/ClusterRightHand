#!/bin/sh
# Runs before the package manager removes crha. Shared by deb and rpm: deb passes remove/purge
# words, rpm passes the number of installed copies (0 removal, 1 upgrade).
set -eu

removal=0
case "${1:-}" in
remove|purge|0) removal=1 ;;
esac
[ "$removal" = 1 ] || exit 0

removed=0
for unit in /etc/systemd/system/crha.service /etc/systemd/system/crha-privileged.service; do
	[ -f "$unit" ] || continue
	grep -qx 'X-CRH-Managed=1' "$unit" || continue
	if [ -d /run/systemd/system ]; then
		systemctl disable --now "$(basename "$unit")" || true
	fi
	rm -f "$unit"
	removed=1
done
if [ "$removed" = 1 ] && [ -d /run/systemd/system ]; then
	systemctl daemon-reload || true
fi
