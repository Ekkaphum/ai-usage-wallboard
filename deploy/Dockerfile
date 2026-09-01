# Optional: run the board in a container. The adapters read the host's log
# directories, so those must be mounted read-only — the container never needs
# write access to anything outside its own /app/data volume.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/lib/db/migrations ./lib/db/migrations
COPY --from=build /app/config ./config
EXPOSE 4000
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "4000"]
