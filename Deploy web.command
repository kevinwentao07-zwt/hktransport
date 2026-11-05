#!/bin/zsh
# Publishes web/ to the server named in .env.deploy, which stays out of the repository.
set -euo pipefail

project_root="${0:A:h}"
source "$project_root/.env.deploy"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
rsync -a --exclude test --exclude README.md --exclude .nojekyll "$project_root/web/" "$stage/"

# A new address per release, so returning visitors can't mix new pages with cached files.
stamp="$(date +%s)"
find "$stage" -type f \( -name '*.html' -o -name '*.js' \) -not -path '*/vendor/*' \
    -exec sed -i '' "s/v=dev/v=$stamp/g" {} +

rsync -az --delete -e "ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o BatchMode=yes" \
    "$stage/" "$DEPLOY_HOST:/var/www/hktransport/"
print "Published $stamp to https://$DEPLOY_DOMAIN/"
