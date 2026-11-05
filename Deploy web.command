#!/bin/zsh
# Publishes web/ to the server named in .env.deploy, which stays out of the repository.
set -euo pipefail

project_root="${0:A:h}"
source "$project_root/.env.deploy"
rsync -az --delete --exclude test --exclude README.md --exclude .nojekyll \
    -e "ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o BatchMode=yes" \
    "$project_root/web/" "$DEPLOY_HOST:/var/www/hktransport/"
print "Published to https://$DEPLOY_DOMAIN/"
