FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.20.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/app/data/lab-planning.sqlite
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4310
VOLUME ["/app/data"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
