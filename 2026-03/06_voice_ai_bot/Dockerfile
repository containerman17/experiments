FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
CMD ["bun", "run", "index.ts"]
