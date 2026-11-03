#!/bin/sh
# Process control inside the privileged system test container. The entrypoint starts the three processes; tests call
# this to restart them between cases (privileged mode restart, crha reconnect, trust reload) and to
# reset the privileged mode's persistent lists.
#
#   privctl.sh start-priv | stop-priv | restart-priv | hup-priv
#   privctl.sh start-crha | stop-crha | restart-crha
#   privctl.sh start-sshd | stop-sshd
#   privctl.sh start-all | stop-all
#   privctl.sh reset-priv-state        remove the used list (fresh authorized state)
#   privctl.sh wait-priv-socket        block until the privileged socket accepts connections
#   privctl.sh status
#
# The pids live in /run/priv. The processes run as the container's root (privileged mode, sshd) and as
# uid 998 crha (non-privileged mode); a test that needs another uid uses podman exec --user.
set -eu

CRHA=${CRHA_BIN:-/usr/local/bin/crha}
PRIV_CONFIG=${PRIV_CONFIG:-/etc/crha/privileged.toml}
CRHA_CONFIG=${CRHA_CONFIG:-/etc/crha/crha.toml}
PRIV_SOCKET=${PRIV_SOCKET:-/run/crha/privileged.sock}
SSHD_CONFIG=${SSHD_CONFIG:-/etc/ssh/sshd_config.priv}
# Extra arguments appended to every crha invocation (the soak harness passes a debug build's
# --pprof-listen here). Unset keeps the command lines exactly as before; the values are split on
# whitespace like any other unquoted shell variable.
CRHA_RUN_ARGS=${CRHA_RUN_ARGS:-}
CRHA_PRIV_ARGS=${CRHA_PRIV_ARGS:-}
RUN=/run/priv
LOG=/var/log/crha

mkdir -p "$RUN" "$LOG"

# start_daemon <name> <user> <command...>: background process with logs under /var/log/crha.
start_daemon() {
	name=$1
	user=$2
	shift 2
	pidfile=$RUN/$name.pid
	if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
		return 0
	fi
	if [ "$user" = root ]; then
		setsid "$@" >>"$LOG/$name.log" 2>&1 &
	else
		setsid setpriv --reuid="$user" --regid="$user" --init-groups "$@" >>"$LOG/$name.log" 2>&1 &
	fi
	echo $! >"$pidfile"
}

# stop_daemon <name> [signal]: signal the process group, wait briefly, then SIGKILL.
stop_daemon() {
	name=$1
	signal=${2:-TERM}
	pidfile=$RUN/$name.pid
	[ -f "$pidfile" ] || return 0
	pid=$(cat "$pidfile")
	rm -f "$pidfile"
	if ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi
	kill -"$signal" -- "-$pid" 2>/dev/null || kill -"$signal" "$pid" 2>/dev/null || true
	i=0
	while [ "$i" -lt 100 ] && kill -0 "$pid" 2>/dev/null; do
		sleep 0.05
		i=$((i + 1))
	done
	if kill -0 "$pid" 2>/dev/null; then
		kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
	fi
}

wait_socket() {
	i=0
	while [ "$i" -lt 300 ]; do
		if [ -S "$PRIV_SOCKET" ]; then
			return 0
		fi
		sleep 0.05
		i=$((i + 1))
	done
	echo "privileged socket $PRIV_SOCKET did not appear" >&2
	return 1
}

start_sshd() {
	mkdir -p /run/sshd /run/priv
	# The tests bind-mount host keys; without them sshd cannot start and the tests say why.
	if [ ! -s /opt/crh/ssh/ssh_host_ed25519_key ]; then
		echo "missing /opt/crh/ssh/ssh_host_ed25519_key" >&2
		return 1
	fi
	# The port is the one the harness chose, so several test containers (and the host's own
	# services) do not fight over 2222; the shipped config keeps 2222 as its default.
	if [ -n "${PRIV_SSH_PORT:-}" ] && [ "$PRIV_SSH_PORT" != "2222" ]; then
		sed "s/^Port .*/Port $PRIV_SSH_PORT/" "$SSHD_CONFIG" >/run/priv/sshd_config
		SSHD_CONFIG=/run/priv/sshd_config
	fi
	/usr/sbin/sshd -f "$SSHD_CONFIG"
}

case ${1:-} in
start-priv)
	start_daemon priv root "$CRHA" privileged run --config "$PRIV_CONFIG" $CRHA_PRIV_ARGS
	wait_socket
	;;
stop-priv) stop_daemon priv ;;
restart-priv)
	stop_daemon priv
	start_daemon priv root "$CRHA" privileged run --config "$PRIV_CONFIG" $CRHA_PRIV_ARGS
	wait_socket
	;;
hup-priv)
	pid=$(cat "$RUN/priv.pid")
	kill -HUP "$pid"
	;;
start-crha)
	start_daemon crha 998 "$CRHA" run --config "$CRHA_CONFIG" $CRHA_RUN_ARGS
	;;
stop-crha) stop_daemon crha ;;
restart-crha)
	stop_daemon crha
	start_daemon crha 998 "$CRHA" run --config "$CRHA_CONFIG" $CRHA_RUN_ARGS
	;;
start-sshd) start_sshd ;;
stop-sshd)
	if [ -f /run/sshd.pid ]; then
		kill -TERM "$(cat /run/sshd.pid)" 2>/dev/null || true
		rm -f /run/sshd.pid
	fi
	;;
start-all)
	start_sshd || exit 1
	[ -f "$PRIV_CONFIG" ] && {
		start_daemon priv root "$CRHA" privileged run --config "$PRIV_CONFIG" $CRHA_PRIV_ARGS
		wait_socket
	}
	[ -f "$CRHA_CONFIG" ] && start_daemon crha 998 "$CRHA" run --config "$CRHA_CONFIG" $CRHA_RUN_ARGS
	;;
stop-all)
	stop_daemon crha
	stop_daemon priv
	# sshd is not a daemonized child here: it is started by sshd itself and has a pid file.
	if [ -f /run/sshd.pid ]; then
		kill -TERM "$(cat /run/sshd.pid)" 2>/dev/null || true
		rm -f /run/sshd.pid
	fi
	;;
reset-priv-state)
	stop_daemon priv || true
	rm -f /var/lib/crha/privileged/used
	;;
wait-priv-socket) wait_socket ;;
status)
	for name in priv crha; do
		pidfile=$RUN/$name.pid
		if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
			echo "$name running pid=$(cat "$pidfile")"
		else
			echo "$name stopped"
		fi
	done
	if [ -f /run/sshd.pid ] && kill -0 "$(cat /run/sshd.pid)" 2>/dev/null; then
		echo "sshd running pid=$(cat /run/sshd.pid)"
	else
		echo "sshd stopped"
	fi
	;;
*)
	echo "usage: $0 {start-priv|stop-priv|restart-priv|hup-priv|start-crha|stop-crha|restart-crha|start-sshd|stop-sshd|start-all|stop-all|reset-priv-state|wait-priv-socket|status}" >&2
	exit 2
	;;
esac
