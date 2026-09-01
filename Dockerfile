# Build stage - needs devDependencies for tsc
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

# Runtime stage - production dependencies only
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# The knowledge tools read markdown from /app/knowledge at runtime
# (dist/tools/../../knowledge), so it has to ship in the image.
COPY knowledge ./knowledge

# App Platform's default HTTP port. Do NOT also set MCP_PORT unless it matches:
# parseArgs() lets MCP_PORT override --port, and a mismatch makes the container
# listen on one port while the platform health-checks another.
EXPOSE 8080
CMD ["node", "dist/index.js", "--http", "--port", "8080"]
