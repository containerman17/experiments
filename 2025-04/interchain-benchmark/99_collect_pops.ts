#!/usr/bin/env bun

import { getNodeIps } from "./lib";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execAsync = promisify(exec);

// Collect complete JSON response from a single node
async function getNodeResponse(ip: string): Promise<any | null> {
    try {
        console.log(`Fetching info from ${ip}...`);
        const sshKeyPath = "./id_ed25519";

        const { stdout } = await execAsync(
            `ssh -F /dev/null -o IdentitiesOnly=yes -i ${sshKeyPath} -o StrictHostKeyChecking=no ubuntu@${ip} "curl -s -X POST --data '{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"method\\\":\\\"info.getNodeID\\\"}' -H 'content-type:application/json;' 127.0.0.1:9650/ext/info"`
        );

        const response = JSON.parse(stdout);
        console.log(`Got response from ${ip}`);
        return response;
    } catch (error) {
        console.error(`Error connecting to ${ip}:`, error);
        return null;
    }
}

const clusters = getNodeIps();
console.log("Found clusters:", Object.keys(clusters));

// Object to store results
const pops: Record<string, any[]> = {};

// Process each cluster
for (const [clusterName, ips] of Object.entries(clusters)) {
    console.log(`Processing cluster ${clusterName} with ${ips.length} nodes...`);

    // Process nodes sequentially to prevent SSH connection issues
    const responses: any[] = [];
    for (const ip of ips) {
        const response = await getNodeResponse(ip);
        if (response) {
            responses.push(response);
        }
    }

    pops[clusterName] = responses;
}

// Save results to file
fs.writeFileSync("pops.json", JSON.stringify(pops, null, 2));
console.log("Results saved to pops.json");
