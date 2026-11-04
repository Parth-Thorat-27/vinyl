# Container image for hosts like Fly.io or Railway (Render can use render.yaml instead).
# Vinyl has no dependencies, so this is just Node plus the app.
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV VINYL_CLOUD=1 \
    PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
