FROM node:22.20.0-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --include=dev; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && npm prune --omit=dev

FROM node:22.20.0-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
