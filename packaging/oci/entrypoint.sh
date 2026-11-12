#!/bin/sh
# The crhs image entrypoint: with arguments, run that crhs command; without, initialize /crhs-data on the
# first start and serve. See doc/design/distribution.md.
set -eu

data=/crhs-data
config="$data/crhs.toml"
crhs=/opt/crhs/crhs.mjs

# A command (--version, keys import, user add, …) runs as given, initialized or not.
if [ "$#" -gt 0 ]; then
	exec node "$crhs" "$@"
fi

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

exec node "$crhs" serve --config "$config"
