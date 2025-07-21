interface RateLimitRecord {
    count: number;
    resetTime: number;
    burstTokens: number;
}

const requestCounts = new Map<string, RateLimitRecord>();

// Rate limiting configuration
const REQUESTS_PER_SECOND = 2;
const WINDOW_SIZE_MS = 1000; // 1 second
const BURST_ALLOWANCE = 5;  // Extra tokens for burst

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / WINDOW_SIZE_MS) * WINDOW_SIZE_MS;

    let record = requestCounts.get(ip);

    // Initialize or reset if new window
    if (!record || record.resetTime <= now) {
        record = {
            count: 0,
            resetTime: windowStart + WINDOW_SIZE_MS,
            burstTokens: BURST_ALLOWANCE
        };
        requestCounts.set(ip, record);
    }

    // Check if request is allowed
    const totalAllowance = REQUESTS_PER_SECOND + record.burstTokens;

    if (record.count < totalAllowance) {
        record.count++;

        // Consume burst token if over normal limit
        if (record.count > REQUESTS_PER_SECOND) {
            record.burstTokens--;
        }

        return { allowed: true };
    }

    // Rate limit exceeded
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
}

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of requestCounts.entries()) {
        if (record.resetTime < now - WINDOW_SIZE_MS) {
            requestCounts.delete(ip);
        }
    }
}, 60000); // Clean every minute

// Extract real IP from Cloudflare headers or fallback
export function extractClientIP(headers: any): string {
    // Cloudflare provides real IP in CF-Connecting-IP
    return headers['cf-connecting-ip'] ||
        headers['x-forwarded-for']?.split(',')[0] ||
        headers['x-real-ip'] ||
        'unknown';
} 
