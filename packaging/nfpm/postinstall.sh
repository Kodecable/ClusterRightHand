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
	# The privileged state directory moved out of crha's own /var/lib/crha, which the privileged
	# mode now refuses. Move a configuration that still names the old default; the used list starts
	# empty (doc/design/privilege.md "Used list").
	conf=/etc/crha/privileged.toml
	if [ -f "$conf" ] && grep -Eq '^[[:space:]]*state_dir[[:space:]]*=[[:space:]]*"/var/lib/crha/privileged/?"[[:space:]]*$' "$conf"; then
		# The privileged mode may run as another user than root; keep the old directory's owner.
		owner=root:root
		if [ -d /var/lib/crha/privileged ]; then owner=$(stat -c %u:%g /var/lib/crha/privileged); fi
		install -d -o "${owner%:*}" -g "${owner#*:}" -m 0700 /var/lib/crha-privileged
		sed -i -E 's|^([[:space:]]*state_dir[[:space:]]*=[[:space:]]*)"/var/lib/crha/privileged/?"|\1"/var/lib/crha-privileged"|' "$conf"
		echo "crha: moved the privileged state_dir in $conf to /var/lib/crha-privileged"
	fi
	# crha and crha-privileged must run the same version, so restart the privileged one first.
	if [ -d /run/systemd/system ]; then
		systemctl try-restart crha-privileged.service crha.service || true
	fi
elif [ "$mode" = install ]; then
	echo "run: sudo crha enroll"
fi
