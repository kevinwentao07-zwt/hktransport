#!/bin/zsh
# Puts both Google keys on the server. They are typed here, hidden, and go straight over SSH.
set -euo pipefail

source "${0:A:h}/.env.deploy"
read -rs "map_key?Google map key, hktransport-map (hidden): "
print
read -rs "places_key?Google places key, hktransport-places (hidden): "
print
[[ -n "$map_key" && -n "$places_key" ]] || { print "Both keys are needed."; exit 1; }
print -r -- "GOOGLE_MAP_KEY=$map_key
GOOGLE_PLACES_KEY=$places_key" | ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$DEPLOY_HOST" \
    "sudo sh -c 'umask 077; mkdir -p /etc/hktransport; cat > /etc/hktransport/google.env; systemctl restart hktransport-ai'"
unset map_key places_key
print "Saved on the server."
