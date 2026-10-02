# The hub has no dependencies: plain Node. Build context is this folder (hub/).
FROM node:24-alpine
WORKDIR /app
COPY hub.mjs proxy.mjs tokens.mjs downloads.mjs ./
ENV NODE_ENV=production HUB_DATA_DIR=/data PORT=8080
USER node
EXPOSE 8080
CMD ["node", "hub.mjs"]
