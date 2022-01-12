#!/bin/bash
set -euxo pipefail

NAMESPACE=$1
CHART_PATH=$2
TAG=$3
echo "Creating Helm installation in $NAMESPACE namespace"

helm upgrade --install --atomic -n $NAMESPACE digital-marketplace $CHART_PATH --set tag=$TAG
