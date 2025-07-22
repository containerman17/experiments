import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

interface NodeDatabase {
    [nodeId: string]: {
        [subnetId: string]: number; // timestamp
    };
}

class Database {
    private data: NodeDatabase = {};
    private dataDir: string;
    private filePath: string;

    constructor() {
        this.dataDir = process.env.DATA_DIR || './data';
        this.filePath = path.join(this.dataDir, 'chains.json');
        this.loadFromDisk();
        this.initializeNodes();
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
                try {
                    const fileContent = readFileSync(this.filePath, 'utf-8');
                    this.data = JSON.parse(fileContent);
                    console.log(`Loaded database from ${this.filePath}`);
                    return;
                } catch (error) {
                    console.error(`Main database file corrupted: ${error}`);

                    // Try backup file
                    const backupPath = path.join(this.dataDir, 'chains.backup.json');
                    if (existsSync(backupPath)) {
                        try {
                            const backupContent = readFileSync(backupPath, 'utf-8');
                            this.data = JSON.parse(backupContent);
                            console.log(`Recovered database from backup: ${backupPath}`);

                            // Restore main file from backup
                            writeFileSync(this.filePath, backupContent);
                            console.log(`Restored main database file from backup`);
                            return;
                        } catch (backupError) {
                            console.error(`Backup file also corrupted: ${backupError}`);
                        }
                    }
                }
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

    private initializeNodes(): void {
        const nodeCount = parseInt(process.env.NODE_COUNT || '3');
        if (nodeCount > 999) {
            throw new Error('NODE_COUNT cannot exceed 999');
        }

        let needsSave = false;
        for (let i = 1; i <= nodeCount; i++) {
            const nodeId = `node${i.toString().padStart(3, '0')}`;
            if (!this.data[nodeId]) {
                this.data[nodeId] = {};
                needsSave = true;
            }
        }

        if (needsSave) {
            this.saveToDisk(); // Database just saves data
        }
    }

    getAllNodes(): string[] {
        return Object.keys(this.data);
    }

    getNodeSubnets(nodeId: string): string[] {
        return Object.keys(this.data[nodeId] || {});
    }

    addSubnetToNode(nodeId: string, subnetId: string): void {
        if (!this.data[nodeId]) {
            this.data[nodeId] = {};
        }
        this.data[nodeId][subnetId] = Date.now();
        this.saveToDisk();
    }

    removeSubnetFromNode(nodeId: string, subnetId: string): void {
        if (this.data[nodeId] && this.data[nodeId][subnetId]) {
            delete this.data[nodeId][subnetId];
            this.saveToDisk();
        }
    }

    isSubnetRegistered(subnetId: string): { isRegistered: boolean; nodeId: string | null } {
        for (const [nodeId, subnets] of Object.entries(this.data)) {
            if (subnets[subnetId]) {
                return { isRegistered: true, nodeId };
            }
        }
        return { isRegistered: false, nodeId: null };
    }

    getNodeWithLowestSubnetCount(): string {
        let lowestNode = '';
        let lowestCount = Infinity;

        for (const [nodeId, subnets] of Object.entries(this.data)) {
            const count = Object.keys(subnets).length;
            if (count < lowestCount) {
                lowestCount = count;
                lowestNode = nodeId;
            }
        }

        return lowestNode;
    }

    areAllNodesFull(): boolean {
        for (const [nodeId, subnets] of Object.entries(this.data)) {
            if (Object.keys(subnets).length < 16) {
                return false;
            }
        }
        return true;
    }

    getOldestSubnetAcrossAllNodes(): { nodeId: string; subnetId: string; timestamp: number } | null {
        let oldest: { nodeId: string; subnetId: string; timestamp: number } | null = null;

        for (const [nodeId, subnets] of Object.entries(this.data)) {
            for (const [subnetId, timestamp] of Object.entries(subnets)) {
                if (!oldest || timestamp < oldest.timestamp) {
                    oldest = { nodeId, subnetId, timestamp };
                }
            }
        }

        return oldest;
    }

    getDatabase(): NodeDatabase {
        return this.data;
    }

    // Assign subnet to appropriate node, handling full capacity automatically
    assignSubnetToNode(subnetId: string): {
        nodeId: string;
        replacedSubnet: string | null;
        isNewAssignment: boolean
    } {
        // Check if subnet is already registered
        const { isRegistered, nodeId: existingNode } = this.isSubnetRegistered(subnetId);
        if (isRegistered && existingNode) {
            return {
                nodeId: existingNode,
                replacedSubnet: null,
                isNewAssignment: false
            };
        }

        let targetNode: string;
        let replacedSubnet: string | null = null;

        if (this.areAllNodesFull()) {
            // All nodes are full, replace oldest subnet
            const oldest = this.getOldestSubnetAcrossAllNodes();
            if (!oldest) {
                throw new Error('All nodes full but no subnets found');
            }

            targetNode = oldest.nodeId;
            replacedSubnet = oldest.subnetId;
            this.removeSubnetFromNode(oldest.nodeId, oldest.subnetId); // Just remove from DB

            console.log(`Replacing ${replacedSubnet} with ${subnetId} on ${targetNode}`);
        } else {
            // Find node with lowest subnet count
            targetNode = this.getNodeWithLowestSubnetCount();
            console.log(`Assigning ${subnetId} to ${targetNode}`);
        }

        // Add subnet to node
        this.addSubnetToNode(targetNode, subnetId);

        return {
            nodeId: targetNode,
            replacedSubnet,
            isNewAssignment: true
        };
    }
}

export const database = new Database(); 
