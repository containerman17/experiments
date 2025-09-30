import fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHttpProxy from '@fastify/http-proxy';
import fastifyWebsocket from '@fastify/websocket';
import { database, type NodeAssignment } from './database.js';
import { checkSubnetExists, getSubnetIdFromChainId, getNodeInfo, NodeInfoResult, NodeInfoResponse } from './node_apis.js';
import { generateDockerCompose } from './docker-composer.js';
import { ADMIN_PASSWORD, INIT_CONTAINERS_INTERVAL_MS } from './config.js';

// TODO: fix - move bootstrap error message to const as required
const BOOTSTRAP_ERROR_MESSAGE = 'Node is not ready or still bootstrapping';

// Helper function to build subnet status response
async function buildSubnetStatusResponse(subnetId: string, assignments: NodeAssignment[]) {
    if (assignments.length === 0) {
        return {
            subnetId: subnetId,
            nodes: []
        };
    }

    const nodes = [];
    for (const assignment of assignments.sort((a, b) => a.nodeIndex - b.nodeIndex)) {
        const nodeInfo = await getNodeInfo(9652 + assignment.nodeIndex * 2);
        if (!nodeInfo.result) {
            throw new Error(`Nodeinfo call failed for node ${assignment.nodeIndex} with error: ${JSON.stringify(nodeInfo.error || "Unknown error")}`);
        }

        console.log(`Nodeinfo call for node ${assignment.nodeIndex} returned: ${JSON.stringify(nodeInfo)}`);

        nodes.push({
            nodeIndex: assignment.nodeIndex,
            nodeInfo: { result: { ...nodeInfo.result } },
            dateCreated: assignment.dateCreated,
            expiresAt: assignment.expiresAt
        });
    }

    return {
        subnetId: subnetId,
        nodes: nodes
    };
}

async function createServer() {
    const server = fastify({ logger: true });

    // Register rate limiting
    // await server.register(fastifyRateLimit, {
    //     max: 100, // Maximum 100 requests
    //     timeWindow: '1 minute', // Per 1 minute
    //     cache: 10000,
    //     skipOnError: false,
    //     // Exclude WebSocket connections from rate limiting
    //     keyGenerator: (request: any) => {
    //         // Return null for WebSocket requests to skip rate limiting
    //         if (request.headers.upgrade === 'websocket' || request.url.endsWith('/ws')) {
    //             return null;
    //         }
    //         // Default key generator (IP-based)
    //         return request.ip;
    //     },
    //     errorResponseBuilder: function (request, context) {
    //         return {
    //             statusCode: 429,
    //             error: 'Too Many Requests',
    //             message: `Rate limit exceeded. Retry in ${context.after}`,
    //             retryAfter: Math.round(context.ttl / 1000) // Convert ms to seconds
    //         };
    //     }
    // });

    // Register Swagger (OpenAPI) documentation
    await server.register(fastifySwagger, {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'SlimNode API',
                description: 'API service that manages multiple Avalanche nodes with automatic subnet registration and explicit node assignment',
                version: '1.0.0'
            },
            servers: [
                {
                    url: 'https://multinode-experimental.solokhin.com',
                    description: 'Dev preview server'
                },
                {
                    url: 'http://localhost:3454',
                    description: 'Development server'
                },
            ],
            tags: [
                {
                    name: 'admin',
                    description: 'Admin endpoints for managing subnet nodes (requires authentication)'
                },
                {
                    name: 'proxy',
                    description: 'Proxy endpoints for blockchain interaction. Supports both HTTP RPC at /ext/bc/:chainId/rpc and WebSocket connections at /ext/bc/:chainId/ws'
                }
            ],
            components: {
                securitySchemes: {
                    adminPassword: {
                        type: 'apiKey',
                        name: 'password',
                        in: 'query',
                        description: 'Admin password for authentication'
                    }
                }
            }
        }
    });

    // Register Swagger UI
    await server.register(fastifySwaggerUI, {
        routePrefix: '/docs',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
            persistAuthorization: true
        },
        staticCSP: true,
        transformSpecification: (swaggerObject, request, reply) => {
            // You can transform the spec here if needed
            return swaggerObject;
        }
    });

    // Initialize Docker containers on startup
    async function initializeContainers() {
        console.log('Starting Docker containers...');
        await generateDockerCompose(); // Generate compose file and start containers on initial startup
    }

    // Start initialization
    setInterval(() => initializeContainers().catch(e => {
        console.error('Error initializing containers:', e);
    }), INIT_CONTAINERS_INTERVAL_MS);

    // Authentication middleware for admin endpoints
    server.addHook('preHandler', (req, reply, done) => {
        if (req.url.startsWith('/node_admin/')) {
            const { password } = req.query as { password?: string };
            if (!password || password !== ADMIN_PASSWORD) {
                console.log(`Unauthorized admin access from ${req.ip}`);
                reply.code(401).send({ error: 'Unauthorized' });
                return;
            }
        }
        done();
    });

    server.get('/node_admin/subnets/status/:subnetId', {
        schema: {
            tags: ['admin'],
            summary: 'Get subnet status',
            description: 'Returns detailed information about all nodes assigned to a subnet',
            params: {
                type: 'object',
                properties: {
                    subnetId: {
                        type: 'string',
                        description: 'The subnet ID'
                    }
                },
                required: ['subnetId']
            },
            querystring: {
                type: 'object',
                properties: {
                    password: {
                        type: 'string',
                        description: 'Admin password'
                    }
                },
                required: ['password']
            },
            response: {
                200: {
                    description: 'Successful response',
                    type: 'object',
                    properties: {
                        subnetId: { type: 'string' },
                        nodes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    nodeIndex: { type: 'number' },
                                    nodeInfo: {
                                        type: 'object',
                                        properties: {
                                            result: {
                                                type: 'object',
                                                properties: {
                                                    nodeID: { type: 'string' },
                                                    nodePOP: {
                                                        type: 'object',
                                                        properties: {
                                                            publicKey: { type: 'string' },
                                                            proofOfPossession: { type: 'string' }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    dateCreated: { type: 'number' },
                                    expiresAt: { type: 'number' }
                                }
                            }
                        }
                    }
                },
                404: {
                    description: 'Node info request failed',
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                }
            },
            security: [{ adminPassword: [] }]
        }
    }, async (req, reply) => {
        const { subnetId } = req.params as { subnetId: string };
        const assignments = database.getSubnetAssignments(subnetId);

        try {
            const response = await buildSubnetStatusResponse(subnetId, assignments);
            return reply.send(response);
        } catch (error) {
            return reply.code(404).send({
                error: error instanceof Error ? error.message : 'Failed to get subnet status'
            });
        }
    });

    server.post('/node_admin/subnets/add/:subnetId', {
        schema: {
            tags: ['admin'],
            summary: 'Add node to subnet',
            description: 'Assigns an available node to the subnet',
            params: {
                type: 'object',
                properties: {
                    subnetId: {
                        type: 'string',
                        description: 'The subnet ID'
                    }
                },
                required: ['subnetId']
            },
            querystring: {
                type: 'object',
                properties: {
                    password: {
                        type: 'string',
                        description: 'Admin password'
                    }
                },
                required: ['password']
            },
            response: {
                200: {
                    description: 'Successful response',
                    type: 'object',
                    properties: {
                        subnetId: { type: 'string' },
                        nodes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    nodeIndex: { type: 'number' },
                                    nodeInfo: {
                                        type: 'object',
                                        properties: {
                                            result: {
                                                type: 'object',
                                                properties: {
                                                    nodeID: { type: 'string' },
                                                    nodePOP: {
                                                        type: 'object',
                                                        properties: {
                                                            publicKey: { type: 'string' },
                                                            proofOfPossession: { type: 'string' }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    dateCreated: { type: 'number' },
                                    expiresAt: { type: 'number' }
                                }
                            }
                        }
                    }
                },
                400: {
                    description: 'Bad request',
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                },
                500: {
                    description: 'Internal server error',
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                }
            },
            security: [{ adminPassword: [] }]
        }
    }, async (req, reply) => {
        const { subnetId } = req.params as { subnetId: string };

        // Validate subnet exists on Avalanche network
        const subnetExists = await checkSubnetExists(subnetId);
        if (!subnetExists) {
            return reply.code(400).send({
                error: `Subnet ${subnetId} does not exist on Avalanche network`
            });
        }

        try {
            // Add a node to the subnet
            const newAssignment = database.addNodeToSubnet(subnetId);

            // Get all assignments including the new one
            const allAssignments = database.getSubnetAssignments(subnetId);

            // Build response with all nodes BEFORE restarting containers
            let response;
            try {
                response = await buildSubnetStatusResponse(subnetId, allAssignments);
            } catch (error) {
                // Remove the assignment if we can't get node info
                database.removeAssignment(subnetId, newAssignment.nodeIndex);
                return reply.code(500).send({
                    error: error instanceof Error ? error.message : 'Failed to get node info'
                });
            }

            // Now regenerate docker compose and restart containers
            await generateDockerCompose();

            return reply.send(response);
        } catch (error) {
            return reply.code(500).send({
                error: error instanceof Error ? error.message : 'Failed to add node to subnet'
            });
        }
    });

    server.delete('/node_admin/subnets/delete/:subnetId/:nodeIndex', {
        schema: {
            tags: ['admin'],
            summary: 'Remove node from subnet',
            description: 'Removes a specific node from the subnet',
            params: {
                type: 'object',
                properties: {
                    subnetId: {
                        type: 'string',
                        description: 'The subnet ID'
                    },
                    nodeIndex: {
                        type: 'string',
                        description: 'The node index to remove'
                    }
                },
                required: ['subnetId', 'nodeIndex']
            },
            querystring: {
                type: 'object',
                properties: {
                    password: {
                        type: 'string',
                        description: 'Admin password'
                    }
                },
                required: ['password']
            },
            response: {
                200: {
                    description: 'Successful response',
                    type: 'object',
                    properties: {
                        subnetId: { type: 'string' },
                        nodes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    nodeIndex: { type: 'number' },
                                    nodeInfo: {
                                        type: 'object',
                                        properties: {
                                            result: {
                                                type: 'object',
                                                properties: {
                                                    nodeID: { type: 'string' },
                                                    nodePOP: {
                                                        type: 'object',
                                                        properties: {
                                                            publicKey: { type: 'string' },
                                                            proofOfPossession: { type: 'string' }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    dateCreated: { type: 'number' },
                                    expiresAt: { type: 'number' }
                                }
                            }
                        }
                    }
                },
                400: {
                    description: 'Bad request',
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                },
                404: {
                    description: 'Assignment not found',
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                }
            },
            security: [{ adminPassword: [] }]
        }
    }, async (req, reply) => {
        const { subnetId, nodeIndex: nodeIndexStr } = req.params as { subnetId: string, nodeIndex: string };
        const nodeIndex = parseInt(nodeIndexStr);

        if (isNaN(nodeIndex) || nodeIndex < 0) {
            return reply.code(400).send({
                error: 'Invalid nodeIndex parameter'
            });
        }

        // First, get the current assignment to verify it exists
        const currentAssignment = database.getSubnetAssignments(subnetId)
            .find(a => a.nodeIndex === nodeIndex);

        if (!currentAssignment) {
            return reply.code(404).send({
                error: `Assignment not found for subnet ${subnetId} and node ${nodeIndex}`
            });
        }

        // Remove the assignment
        database.removeAssignment(subnetId, nodeIndex);

        // Get remaining assignments and build response BEFORE restarting containers
        const remainingAssignments = database.getSubnetAssignments(subnetId);

        try {
            const response = await buildSubnetStatusResponse(subnetId, remainingAssignments);

            // Now regenerate docker compose and restart containers
            await generateDockerCompose();

            return reply.send(response);
        } catch (error) {
            // Note: We cannot easily rollback here since the assignment is already removed
            // and docker compose might have been partially executed
            return reply.code(500).send({
                error: error instanceof Error ? error.message : 'Failed to complete deletion'
            });
        }
    });

    // Register WebSocket support (must be before http-proxy for WS support)
    await server.register(fastifyWebsocket);

    // Create a Map to cache chainId -> nodePort mappings for performance
    const chainIdToNodePortCache = new Map<string, number>();
    setInterval(() => {
        chainIdToNodePortCache.clear();
    }, 1000);

    // Helper to get node port for a chainId
    const getNodePortForChain = async (chainId: string): Promise<number | null> => {
        // Check cache first
        if (chainIdToNodePortCache.has(chainId)) {
            return chainIdToNodePortCache.get(chainId)!;
        }

        const subnetId = await getSubnetIdFromChainId(chainId);
        if (!subnetId) {
            return null;
        }

        const assignments = database.getSubnetAssignments(subnetId);
        if (assignments.length === 0) {
            return null;
        }

        const nodePort = 9652 + (assignments[0].nodeIndex * 2);
        chainIdToNodePortCache.set(chainId, nodePort);
        return nodePort;
    };

    // HTTP RPC Proxy
    server.all('/ext/bc/:chainId/rpc', async (request: any, reply: any) => {
        const { chainId } = request.params as { chainId: string };

        console.log(`[HTTP Proxy] ${request.method} request for chainId: ${chainId}, path: ${request.url}`);

        // Handle OPTIONS for CORS
        if (request.method === 'OPTIONS') {
            reply.header('Access-Control-Allow-Origin', '*');
            reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            reply.header('Access-Control-Allow-Headers', '*');
            return reply.code(200).send();
        }

        const subnetId = await getSubnetIdFromChainId(chainId);
        const nodePort = await getNodePortForChain(chainId);
        if (!nodePort) {
            console.log(`[HTTP Proxy] Chain ${chainId} not found in database`);
            return reply.code(404).send({
                error: `Chain ${chainId} not found or not assigned to any node`
            });
        }

        if (request.method === 'GET') {
            // Make an actual eth_chainId request to verify the endpoint works
            try {
                const targetUrl = `http://localhost:${nodePort}${request.url}`;
                const ethChainIdRequest = {
                    jsonrpc: "2.0",
                    method: "eth_chainId",
                    params: [],
                    id: 1
                };

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(ethChainIdRequest)
                });

                const responseData = await response.json() as any;
                const actualChainId = responseData.result;

                return reply.code(200).send(`Endpoint is working!\n\nsubnetId: ${subnetId}\nblockchainId: ${chainId}\neth_chainId response: ${actualChainId}\n\nNow try this to get chainId:\n\ncurl -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' https://${request.host}/ext/bc/${chainId}/rpc`);
            } catch (error) {
                console.error('[HTTP Proxy] Error testing eth_chainId:', error);
                return reply.code(503).send(`Endpoint check failed\n\nsubnetId: ${subnetId}\nblockchainId: ${chainId}\nerror: ${error instanceof Error ? error.message : 'Unknown error'}\n\nThe node might still be bootstrapping. Try the curl command:\n\ncurl -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' https://${request.host}/ext/bc/${chainId}/rpc`);
            }
        } else if (request.method === 'POST') {
            // As expected
        } else {
            throw new Error(`Unsupported method: ${request.method}`);
        }

        console.log(`[HTTP Proxy] Routing to node port: ${nodePort}`);

        try {
            const targetUrl = `http://localhost:${nodePort}${request.url}`;
            console.log(`[HTTP Proxy] Forwarding to: ${targetUrl}`);

            // Add CORS headers
            reply.header('Access-Control-Allow-Origin', '*');
            reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            reply.header('Access-Control-Allow-Headers', '*');

            const headers: any = { ...request.headers };
            delete headers.host;
            delete headers['content-length']; // Let fetch recalculate

            const fetchOptions: any = {
                method: request.method,
                headers
            };

            if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
                fetchOptions.body = JSON.stringify(request.body);
                fetchOptions.headers['content-type'] = 'application/json';
            }

            const response = await fetch(targetUrl, fetchOptions);
            const responseText = await response.text();

            console.log(`[HTTP Proxy] Response status: ${response.status}`);

            return reply
                .code(response.status)
                .header('Content-Type', response.headers.get('content-type') || 'application/json')
                .send(responseText);

        } catch (error) {
            console.error('[HTTP Proxy] Error:', error);
            if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
                return reply.code(503).send({
                    error: BOOTSTRAP_ERROR_MESSAGE,
                    chainId,
                    retry: true
                });
            }
            return reply.code(502).send({
                error: 'Bad Gateway',
                details: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // WebSocket Proxy - create separate instances for each chainId pattern
    // This is a workaround for the context passing issue
    server.get('/ext/bc/:chainId/ws', { websocket: true }, async (connection: any, request: any) => {
        const { chainId } = request.params as { chainId: string };
        console.log(`[WS Proxy] WebSocket connection for chainId: ${chainId}`);
        console.log(`[WS Proxy] Connection object type:`, typeof connection, 'Has socket:', !!connection.socket);

        // In Fastify WebSocket, connection is the socket itself
        const socket = connection.socket || connection;

        const nodePort = await getNodePortForChain(chainId);
        if (!nodePort) {
            console.log(`[WS Proxy] Chain ${chainId} not found in database`);
            socket.close(1008, 'Chain not found');
            return;
        }

        console.log(`[WS Proxy] Creating proxy to node port: ${nodePort}`);

        // Import WebSocket dynamically
        const WebSocket = (await import('ws')).default;

        // Create connection to backend
        const targetUrl = `ws://localhost:${nodePort}${request.url}`;
        console.log(`[WS Proxy] Connecting to: ${targetUrl}`);

        // Clean up headers - only pass necessary ones
        const cleanHeaders: any = {};
        const headersToForward = ['origin', 'user-agent'];
        for (const header of headersToForward) {
            if (request.headers[header]) {
                cleanHeaders[header] = request.headers[header];
            }
        }

        const backendWs = new WebSocket(targetUrl, {
            headers: cleanHeaders
        });

        let isConnected = false;

        // Handle backend connection
        backendWs.on('open', () => {
            console.log(`[WS Proxy] Connected to backend at ${targetUrl}`);
            isConnected = true;
        });

        backendWs.on('message', (data: any) => {
            console.log(`[WS Proxy] Received from backend:`, data.toString().substring(0, 100));
            try {
                socket.send(data);
            } catch (error) {
                console.error(`[WS Proxy] Error sending to client:`, error);
            }
        });

        backendWs.on('error', (error: Error) => {
            console.error(`[WS Proxy] Backend error for ${targetUrl}:`, error.message);
            if (!isConnected) {
                // Connection failed, close with specific error
                socket.close(1011, `Backend connection failed: ${error.message}`);
            } else {
                socket.close(1011, 'Backend error');
            }
        });

        backendWs.on('close', (code, reason) => {
            console.log(`[WS Proxy] Backend closed with code ${code}, reason: ${reason}`);
            if (socket.readyState === WebSocket.OPEN) {
                socket.close(1000);
            }
        });

        // Handle client messages
        socket.on('message', (message: any) => {
            console.log(`[WS Proxy] Received from client:`, message.toString().substring(0, 100));
            if (backendWs.readyState === WebSocket.OPEN) {
                backendWs.send(message);
            }
        });

        socket.on('close', () => {
            console.log(`[WS Proxy] Client closed`);
            backendWs.close();
        });
    });

    return server;
}

// Export the createServer function

export { createServer }; 
