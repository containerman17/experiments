# Build stage
FROM golang:1.24.9-alpine AS builder

# Install build dependencies for CGO
RUN apk add --no-cache git gcc musl-dev

# Set working directory
WORKDIR /app

# Copy go mod files first for better caching
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY *.go ./

# Build the binary
RUN go build -o main .

# Initialize peer store to generate peerlist.json
# RUN ./main initialize_only

# Runtime stage
FROM alpine:latest

# Install runtime dependencies for CGO binaries
RUN apk --no-cache add ca-certificates libc6-compat

# Create tmp directory for certificates
RUN mkdir -p /tmp

# Copy the binary from builder
COPY --from=builder /app/main /main

# Copy the generated peerlist.json from builder
# COPY --from=builder /app/peerlist.json /peerlist.json

# Expose port (assuming the API runs on 8080 based on common patterns)
EXPOSE 8080

# Run the application
CMD ["./main"]
