#!/bin/sh
# Runs after the package manager installed or upgraded crha. Shared by deb and rpm: deb passes
# configure/install/upgrade words, rpm passes the number of installed copies (1 install, 2 upgrade).
set -eu

mode=other
case "${1:-}" in
configure|install)
	# deb postinst passes the old version as the second argument on an upgrade.
	if [ -n "${2:-}" ]; then mode=upgrade; else mode=install; fi
	;;
upgrade)
	mode=upgrade
	;;
1)
	mode=install
	;;
2)
	mode=upgrade
	;;
esac

if [ "$mode" = upgrade ]; then
	# crha and crha-privileged must run the same version, so restart the privileged one first.
	if [ -d /run/systemd/system ]; then
		systemctl try-restart crha-privileged.service crha.service || true
	fi
elif [ "$mode" = install ]; then
	echo "run: sudo crha enroll"
fi
