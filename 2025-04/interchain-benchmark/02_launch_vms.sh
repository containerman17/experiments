#!/bin/bash


NUM_CLUSTERS=30
INSTANCE_COUNT=4

terraform init

# Set default mode to apply if not specified
mode=${1:-apply}

if [ "$mode" == "apply" ]; then
  for i in $(seq 1 $NUM_CLUSTERS); do
    if [ $i -lt 10 ]; then
      cluster="cluster_0$i"
    else
      cluster="cluster_$i"
    fi
    
    # Create or select workspace
    terraform workspace new $cluster 2>/dev/null || terraform workspace select $cluster

    # Run apply sequentially
    echo "Applying for ${cluster}..."
    terraform apply -auto-approve \
      -var="cluster_name=${cluster}" \
      -var="instance_count=${INSTANCE_COUNT}"
    
    echo "Completed apply for ${cluster}"
  done
  
  echo "All apply operations finished"
elif [ "$mode" == "destroy" ]; then
  for i in $(seq 1 $NUM_CLUSTERS); do
    if [ $i -lt 10 ]; then
      cluster="cluster_0$i"
    else
      cluster="cluster_$i"
    fi
    
    # Select workspace
    terraform workspace select $cluster
    terraform refresh

    # Run destroy sequentially
    echo "Destroying ${cluster}..."
    terraform destroy -auto-approve \
      -var="cluster_name=${cluster}" \
      -var="instance_count=${INSTANCE_COUNT}"
    
    echo "Completed destroy for ${cluster}"
  done
  
  echo "All destroy operations finished"
fi
