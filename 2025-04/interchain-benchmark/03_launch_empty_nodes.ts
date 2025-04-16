#!/usr/bin/env bun

import { getNodeIps, applyDockerCompose } from "./lib";

// Get subnetId from command line or environment, default to empty string
const subnetId = process.env.SUBNET_ID || "";
console.log(`Using subnetId: ${subnetId || "(empty)"}`);

const clusters = getNodeIps();
console.log("Found clusters:", Object.keys(clusters));

// Flatten all nodes from all clusters into a single array
const allNodes: string[] = Object.values(clusters).flat();
console.log(`Deploying to ${allNodes.length} nodes...`);

// Deploy to each node in parallel
const deployPromises = allNodes.map(ip => applyDockerCompose(ip, subnetId));
await Promise.all(deployPromises);

console.log("Deployment completed!");
