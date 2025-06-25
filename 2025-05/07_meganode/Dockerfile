FROM oven/bun:1 AS base

WORKDIR /app
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY *.ts ./

RUN bun build ./starter.ts --compile --outfile ./starter
RUN chmod +x /app/starter


FROM avaplatform/subnet-evm_avalanchego:v0.7.4_v1.13.1
COPY --from=base /app/starter /app/starter
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh 
ENTRYPOINT ["/entrypoint.sh"]
