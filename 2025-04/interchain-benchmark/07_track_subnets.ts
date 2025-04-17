#!/usr/bin/env bun

import { getNodeIps, applyDockerCompose } from "./lib";
import fs from 'fs';

// Load chains configuration
const chains = JSON.parse(fs.readFileSync('chains.json', 'utf8')) as Record<string, { subnetId: string, chainId: string }>;
console.log("Loaded chains:", Object.keys(chains));

const clusters = getNodeIps();
console.log("Found clusters:", Object.keys(clusters));

// Deploy to each cluster with its corresponding subnet ID
for (const [clusterName, ips] of Object.entries(clusters)) {
    const chainConfig = chains[clusterName];
    if (!chainConfig) {
        console.warn(`Warning: No chain configuration found for cluster ${clusterName}, skipping...`);
        continue;
    }

    const subnetId = chainConfig.subnetId;
    console.log(`Updating cluster ${clusterName} with subnetId: ${subnetId}`);

    // Deploy to each node in the cluster in parallel
    const deployPromises = ips.map(ip => applyDockerCompose(ip, subnetId));
    await Promise.all(deployPromises);

    console.log(`Deployed subnet ${subnetId} to cluster ${clusterName}`);
}

console.log("All subnets have been successfully tracked!");
