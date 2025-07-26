import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { SUBNET_EXPIRATION_TIME, SUBNETS_PER_NODE, DATA_DIR, NODE_COUNT } from './config';

type SubnetEntry = {
    nodeIds: number[];
    dateCreated: number;
    expiresAt: number;
};

interface NodeDatabase {
    [subnetId: string]: SubnetEntry;
}

class Database {
    private data: NodeDatabase = {};
    private dataDir: string;
    private filePath: string;

    constructor(private nodeCount: number) {
        this.dataDir = DATA_DIR;
        this.filePath = path.join(this.dataDir, 'chains.json');
        this.loadFromDisk();
    }

    private loadFromDisk(): void {
        try {
            // Create data directory if it doesn't exist
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true });
                console.log(`Created data directory: ${this.dataDir}`);
            }

            // Try loading main file first
            if (existsSync(this.filePath)) {
                const fileContent = readFileSync(this.filePath, 'utf-8');
                this.data = JSON.parse(fileContent);
            }

            console.log(`No existing database found, starting fresh`);
        } catch (error) {
            console.error('Error loading database:', error);
            this.data = {};
        }
    }

    private saveToDisk(): void {
        try {
            const jsonData = JSON.stringify(this.data, null, 2);

            // First save to main file
            writeFileSync(this.filePath, jsonData);

            // Then immediately create backup
            const backupPath = path.join(this.dataDir, 'chains.backup.json');
            writeFileSync(backupPath, jsonData);

            console.log(`Database saved to ${this.filePath} (with backup)`);
        } catch (error) {
            console.error('Error saving database:', error);
        }
    }

    private writeSubnet(subnetData: SubnetEntry | undefined, subnetId: string): void {
        if (typeof subnetData === "undefined") {
            delete this.data[subnetId];
        } else {
            this.data[subnetId] = subnetData;
        }
        this.saveToDisk();
    }

    public addOrAdjustSubnet(subnetId: string, count: number): void {
        if (count > this.nodeCount) {
            throw new Error('NODE_COUNT must be greater than 0 to assign subnets');
        }

        const subnetData = this.data[subnetId] || {
            nodeIds: [],
            dateCreated: Date.now(),
            expiresAt: Date.now() + SUBNET_EXPIRATION_TIME,
        };

        const currentCount = subnetData.nodeIds.length;

        if (count === 0) {
            console.log(`Removing subnet ${subnetId} from all nodes due to count 0`);
            // If count is 0, remove the subnet
            this.writeSubnet(undefined, subnetId);
            return;
        }

        if (count < currentCount) {
            //remove some nodes if count is less than current   
            subnetData.nodeIds = subnetData.nodeIds.slice(0, count);
        } else if (count > currentCount) {
            // More nodes needed, find available slots
            const requiredCount = count - currentCount;
            const slots = this.findSlots(subnetData.nodeIds, requiredCount);
            subnetData.nodeIds.push(...slots);
            this.writeSubnet(subnetData, subnetId);
            return;
        }
    }

    private findSlots(excludeNodes: number[], requiredCount: number): number[] {
        for (let i = 0; i < 100; i++) {//curcuit breaker
            const counts = this.getCountsByNode(excludeNodes);

            let result: number[] = [];

            for (let j = 0; j < this.nodeCount; j++) {
                if (!excludeNodes.includes(j) && counts[j] < SUBNETS_PER_NODE) {
                    result.push(j);
                }
            }

            if (result.length >= requiredCount) {
                return result.sort((a, b) => counts[a] - counts[b]).slice(0, requiredCount);
            }

            // If we reach here, it means we need to remove some subnets
            const expiresAtMap = extractExpiresAt(this.data);
            if (Object.keys(expiresAtMap).length === 0) {
                throw new Error('No subnets available to remove. Something went wrong in implementation.');
            }
            const { minKey: oldestSubnetId } = findMinValueKey(expiresAtMap);
            if (!oldestSubnetId) {
                throw new Error('No subnets available to remove. Something went wrong in impementation.');
            }

            console.log(`Removing oldest subnet ${oldestSubnetId} to free up space`, this.data[oldestSubnetId]);
            this.writeSubnet(undefined, oldestSubnetId);
        }
        throw new Error(`Unable to find ${requiredCount} available slots after 100 attempts. Curcuit breaker triggered, this should never happen.`);
    }

    private getCountsByNode(excludeNodes: number[]): Record<number, number> {
        const counts: Record<number, number> = {};

        for (let i = 0; i < this.nodeCount; i++) {
            counts[i] = 0; // Initialize all nodes with 0 count
        }

        for (const subnet of Object.values(this.data)) {
            for (const nodeId of subnet.nodeIds) {
                counts[nodeId] = (counts[nodeId] || 0) + 1;
            }
        }

        for (const nodeId of excludeNodes) {
            delete counts[nodeId];
        }

        return counts;
    }

    public getSubnet(subnetId: string): SubnetEntry | undefined {
        return this.data[subnetId] ? { ...this.data[subnetId] } : undefined;
    }

    public getNodesCount(): number {
        return this.nodeCount;
    }

    public getNodeSubnets(nodeId: number): string[] {
        const subnets: string[] = [];
        for (const [subnetId, entry] of Object.entries(this.data)) {
            if (entry.nodeIds.includes(nodeId)) {
                subnets.push(subnetId);
            }
        }
        return subnets;
    }
}


function findMinValueKey(obj: Record<string, number>): { minKey: string | null, minValue: number } {
    let minKey: string | null = null;
    let minValue = Infinity;

    for (const key in obj) {
        if (obj[key] < minValue) {
            minValue = obj[key];
            minKey = key;
        }
    }

    return { minKey, minValue };
}

function extractExpiresAt(data: NodeDatabase): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [subnetId, entry] of Object.entries(data)) {
        result[subnetId] = entry.expiresAt;
    }
    return result;
}

export let database = new Database(NODE_COUNT);

