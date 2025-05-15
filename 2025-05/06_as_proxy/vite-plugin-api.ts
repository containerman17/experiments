import type { Plugin, ViteDevServer } from 'vite';
import { IncomingMessage, ServerResponse } from 'http';

export function apiPlugin(): Plugin {
    return {
        name: 'vite-plugin-simple-api',
        configureServer(server: ViteDevServer) {
            server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
                if (req.url?.startsWith('/api')) {
                    // Example API endpoint
                    if (req.url === '/api/hello') {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ message: 'Hello from the API!' }));
                        return;
                    }

                    // Add more API routes here as needed
                    // e.g., if (req.url === '/api/another-route') { ... }


                    // Handle 404 for other /api routes
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'API route not found' }));
                    return;
                }
                next();
            });
        },
    };
}

// Example of how to define a more complex route handler
// async function handleProducts(req: IncomingMessage, res: ServerResponse) {
//   if (req.method === 'GET') {
//     // Logic to get products
//     res.setHeader('Content-Type', 'application/json');
//     res.end(JSON.stringify([{ id: 1, name: 'Product A' }]));
//   } else if (req.method === 'POST') {
//     // Logic to create a product
//     // You'll need to parse the request body for POST requests
//     res.setHeader('Content-Type', 'application/json');
//     res.statusCode = 201;
//     res.end(JSON.stringify({ message: 'Product created' }));
//   } else {
//     res.statusCode = 405; // Method Not Allowed
//     res.setHeader('Content-Type', 'application/json');
//     res.end(JSON.stringify({ error: 'Method Not Allowed' }));
//   }
// } 
