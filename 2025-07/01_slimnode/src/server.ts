import fastify from 'fastify';
import dotenv from 'dotenv';
import { database } from './database.js';
import { checkSubnetExists, getSubnetIdFromChainId } from './avalanche.js';
import { generateDockerCompose } from './docker-composer.js';
import { checkRateLimit, extractClientIP } from './rate-limiter.js';

dotenv.config();

const server = fastify({ logger: true });

// TODO: fix - move bootstrap error message to const as required
const BOOTSTRAP_ERROR_MESSAGE = 'Node is not ready or still bootstrapping';

// Initialize Docker containers on startup
console.log('Starting Docker containers...');
generateDockerCompose();

// Rate limiting middleware
server.addHook('preHandler', (req, reply, done) => {
    const clientIP = extractClientIP(req.headers);
    const { allowed, retryAfter } = checkRateLimit(clientIP);

    if (!allowed) {
        console.log(`Rate limit exceeded for IP: ${clientIP}`);
        reply.code(429)
            .header('Retry-After', retryAfter?.toString() || '1')
            .send({
                error: 'Rate limit exceeded',
                retryAfter: retryAfter
            });
        return;
    }

    done();
});

// Authentication middleware for admin endpoints
server.addHook('preHandler', (req, reply, done) => {
    if (req.url.startsWith('/node_admin/')) {
        const { password } = req.query as { password?: string };
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            console.log(`Unauthorized admin access from ${extractClientIP(req.headers)}`);
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }
    done();
});

server.get('/node_admin/registerSubnet/:subnetId', async (req, reply) => {
    const { subnetId } = req.params as { subnetId: string };

    try {
        // Validate subnet exists on Avalanche network
        const subnetExists = await checkSubnetExists(subnetId);
        if (!subnetExists) {
            return reply.code(400).send({
                success: false,
                error: `Subnet ${subnetId} does not exist on Avalanche network`
            });
        }

        // Check if subnet is already registered
        const { isRegistered, nodeId: existingNode } = database.isSubnetRegistered(subnetId);
        if (isRegistered) {
            return {
                success: true,
                message: `Subnet ${subnetId} already registered`,
                nodeId: existingNode,
                isUpdate: false
            };
        }

        // Find node to assign subnet to
        let targetNode: string;
        let replacedSubnet: string | null = null;

        if (database.areAllNodesFull()) {
            // All nodes are full, replace oldest subnet
            const oldest = database.getOldestSubnetAcrossAllNodes();
            if (!oldest) {
                throw new Error('All nodes full but no subnets found');
            }

            targetNode = oldest.nodeId;
            replacedSubnet = oldest.subnetId;
            database.removeSubnetFromNode(oldest.nodeId, oldest.subnetId);

            console.log(`Replacing ${replacedSubnet} with ${subnetId} on ${targetNode}`);
        } else {
            // Find node with lowest subnet count
            targetNode = database.getNodeWithLowestSubnetCount();
            console.log(`Assigning ${subnetId} to ${targetNode}`);
        }

        // Add subnet to node
        database.addSubnetToNode(targetNode, subnetId);

        // Regenerate compose.yml and restart containers
        generateDockerCompose();

        return {
            success: true,
            message: replacedSubnet
                ? `Subnet ${subnetId} registered to ${targetNode}, replaced ${replacedSubnet}`
                : `Subnet ${subnetId} registered to ${targetNode}`,
            nodeId: targetNode,
            replacedSubnet,
            nodeSubnets: database.getNodeSubnets(targetNode)
        };
    } catch (error) {
        console.error('Error registering subnet:', error);
        return reply.code(500).send({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to register subnet'
        });
    }
});

// Debug endpoint to view database state
server.get('/node_admin/status', async () => {
    return {
        nodes: database.getDatabase(),
        nodeCount: database.getAllNodes().length
    };
});

// Proxy endpoint - forwards RPC requests to appropriate node
server.post('/ext/bc/:chainId/rpc', async (req, reply) => {
    const { chainId } = req.params as { chainId: string };

    try {
        // Get subnetId from chainId using cached lookup
        const subnetId = await getSubnetIdFromChainId(chainId);
        if (!subnetId) {
            return reply.code(404).send({
                error: `Chain ${chainId} not found or invalid`
            });
        }

        // Find which node hosts this subnet
        const { isRegistered, nodeId } = database.isSubnetRegistered(subnetId);
        if (!isRegistered || !nodeId) {
            return reply.code(404).send({
                error: `Subnet ${subnetId} for chain ${chainId} is not hosted by any node`
            });
        }

        // Calculate node port (9650 + index * 2)
        const nodes = database.getAllNodes();
        const nodeIndex = nodes.indexOf(nodeId);
        const nodePort = 9650 + (nodeIndex * 2);

        // Forward request to node
        const targetUrl = `http://localhost:${nodePort}/ext/bc/${chainId}/rpc`;

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...Object.fromEntries(
                    Object.entries(req.headers).filter(([key]) =>
                        key.startsWith('x-') || key === 'user-agent'
                    )
                )
            },
            body: JSON.stringify(req.body)
        });

        // Forward response as-is
        const data = await response.text();
        reply.code(response.status)
            .header('Content-Type', response.headers.get('Content-Type') || 'application/json')
            .send(data);

    } catch (error) {
        console.error('Error proxying request:', error);

        if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
            return reply.code(503).send({
                error: BOOTSTRAP_ERROR_MESSAGE,
                chainId,
                retry: true
            });
        }

        return reply.code(500).send({
            error: 'Internal proxy error',
            chainId
        });
    }
});

server.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log('Server listening on port 3000');
}); 
