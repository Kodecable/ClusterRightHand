#!/bin/sh
# Boot sequence of the privileged system test container (doc/design/testing/privileged.md).
#
# sshd starts immediately so the SSH node tests always have a target. The crha processes wait for
# /etc/crha/.ready, which the test writes after `crha enroll` has created the node identity and after
# the privileged.toml naming this node exists. The processes are started through privctl.sh so a test
# can restart them individually; on SIGTERM they are stopped in reverse order.
set -eu

CTL=/usr/local/bin/privctl.sh
READY=/etc/crha/.ready

mkdir -p /run/priv /run/sshd /run/crha /var/log/crha

# The state directory belongs to the non-privileged account; the privileged mode's used list
# stay root-only (doc/design/privilege.md "The privileged mode").
chown crha:crha /var/lib/crha /var/log/crha 2>/dev/null || true
chown root:root /var/lib/crha/privileged 2>/dev/null || true
chmod 0755 /run/crha

if [ "${PRIV_NO_SSHD:-0}" != "1" ]; then
	$CTL start-sshd || {
		echo "entrypoint: sshd failed to start" >&2
		exit 1
	}
fi

stopping=0
on_term() {
	stopping=1
	$CTL stop-all
}
trap on_term TERM INT

echo "entrypoint: sshd up, waiting for $READY"
i=0
while [ ! -f "$READY" ]; do
	if [ "$stopping" = 1 ]; then
		exit 0
	fi
	sleep 0.1
	i=$((i + 1))
	if [ "$i" -gt 6000 ]; then
		echo "entrypoint: $READY never appeared" >&2
		exit 1
	fi
done
echo "entrypoint: starting crha processes"
$CTL start-all || {
	echo "entrypoint: crha failed to start" >&2
	exit 1
}

# Stay as PID 1's child and reap/notice children; SIGTERM is handled above.
while [ "$stopping" = 0 ]; do
	sleep 1
done
exit 0
