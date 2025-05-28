FROM node:22-alpine

WORKDIR /app

RUN npm i tsx -g

COPY package* ./

RUN npm install

COPY . .

CMD ["npx", "tsx", "indexer.ts"]
