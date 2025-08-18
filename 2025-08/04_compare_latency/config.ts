import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface ProviderConfig {
    name: string;
    url: string;
}

// Extract provider configurations from environment variables
export function getProviderConfigs(): ProviderConfig[] {
    const providers: ProviderConfig[] = [];
    const envVars = process.env;
    const urlRegex = /^ENDPOINT_(\d+)_URL$/;
    const nameRegex = /^ENDPOINT_(\d+)_NAME$/;

    const urlMatches = new Map<string, string>();
    const nameMatches = new Map<string, string>();

    for (const [key, value] of Object.entries(envVars)) {
        const urlMatch = key.match(urlRegex);
        const nameMatch = key.match(nameRegex);

        if (urlMatch && value) {
            urlMatches.set(urlMatch[1], value);
        }
        if (nameMatch && value) {
            nameMatches.set(nameMatch[1], value);
        }
    }

    // Combine URL and name pairs
    for (const [index, url] of urlMatches) {
        let name = nameMatches.get(index);

        // If no name provided, extract domain from URL
        if (!name) {
            try {
                const urlObj = new URL(url);
                name = urlObj.hostname;
            } catch (e) {
                console.error(`Invalid URL for endpoint ${index}: ${url}`);
                continue;
            }
        }

        providers.push({ name, url });
    }

    if (providers.length === 0) {
        console.error('No providers found in environment variables!');
        process.exit(1);
    }

    return providers;
}

export const TEST_TIME = 10000; // 10 seconds
