FROM node:20-alpine

WORKDIR /app

COPY package.json .

RUN npm install

COPY *.ts .

CMD ["npx", "-y", "tsx", "index"]
