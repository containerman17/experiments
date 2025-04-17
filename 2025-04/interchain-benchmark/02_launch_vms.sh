#!/bin/bash


NUM_CLUSTERS=2
INSTANCE_COUNT=4

terraform init

# Set default mode to apply if not specified
mode=${1:-apply}

if [ "$mode" == "apply" ]; then
  for i in $(seq 1 $NUM_CLUSTERS); do
    cluster="cluster_$i"
    # Create or select workspace
    terraform workspace new $cluster 2>/dev/null || terraform workspace select $cluster

    terraform apply -auto-approve \
      -var="cluster_name=${cluster}" \
      -var="instance_count=${INSTANCE_COUNT}"
  done
elif [ "$mode" == "destroy" ]; then
  for i in $(seq 1 $NUM_CLUSTERS); do
    cluster="cluster_$i"
    # Select workspace
    terraform workspace select $cluster

    terraform destroy -auto-approve \
      -var="cluster_name=${cluster}" \
      -var="instance_count=${INSTANCE_COUNT}"
  done
fi
