FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install tsx globally for TypeScript execution
RUN npm install -g tsx

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Expose port
EXPOSE 3000

# Run the application
CMD ["npx", "tsx", "src/server.ts"] 
