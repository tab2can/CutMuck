ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-bookworm-slim
FROM ${NODE_IMAGE} AS web-deps
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS web-build
WORKDIR /app
COPY --from=web-deps /app/node_modules ./node_modules
COPY apps/web ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV WORKER_URL=http://worker:8787
COPY --from=web-build /app/.next ./.next
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/package.json ./package.json
COPY --from=web-build /app/public ./public
EXPOSE 3000
CMD ["npm", "run", "start"]
