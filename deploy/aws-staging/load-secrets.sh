#!/bin/sh
# Reads /beehave/staging/* SecureStrings with the instance role and writes them for the API only.
# Values are never printed.
set -eu
umask 077
mkdir -p /run/beehave
tmp=$(mktemp /run/beehave/secrets.XXXXXX)
aws ssm get-parameters-by-path --region ap-southeast-1 --path /beehave/staging/ --with-decryption \
	--query 'Parameters[].[Name,Value]' --output text |
	while IFS="$(printf '\t')" read -r name value; do
		printf '%s=%s\n' "${name##*/}" "$value"
	done >"$tmp"
chown beehave:beehave "$tmp"
mv "$tmp" /run/beehave/secrets.env
