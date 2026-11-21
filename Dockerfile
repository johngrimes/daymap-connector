# Hosted (remote MCP) build of the Daymap connector.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run bundle

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /src/dist/server.mjs ./server.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
