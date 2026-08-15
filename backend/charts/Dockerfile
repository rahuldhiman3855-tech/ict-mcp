# The Playwright base image already carries Chromium plus the system libraries
# it needs, which is the awkward part of running headless Chrome in a container.
# Keep this tag in step with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    SNAPSHOT_DIR=/app/snapshots

COPY package*.json ./
# --ignore-scripts skips the postinstall browser download: this image already
# ships Chromium under /ms-playwright.
RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/snapshots && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
