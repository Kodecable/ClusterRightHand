#!/bin/sh
# The crhs image entrypoint: initialize /crhs-data on the first start, then run crhs.
# See doc/design/distribution.md.
set -eu

data=/crhs-data
config="$data/crhs.toml"
crhs=/opt/crhs/crhs.mjs

if [ ! -f "$config" ]; then
	if [ -f "$data/init.json" ]; then
		node "$crhs" init --answers "$data/init.json"
	elif [ -t 0 ]; then
		node "$crhs" init
	else
		echo "crhs: $config is missing: write the setup answers to $data/init.json," >&2
		echo "crhs: or run the container with -it to answer the setup questions." >&2
		exit 1
	fi
fi

if [ "$#" -gt 0 ]; then
	exec node "$crhs" "$@"
fi
exec node "$crhs" serve --config "$config"
