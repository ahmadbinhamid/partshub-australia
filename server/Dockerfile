# NOTE: 22, not 20 — the production server this image deploys to actually
# runs v22.23.1; that's the source of truth this whole repo is being
# standardised on (dev machine, CI, and this Dockerfile had three different,
# disagreeing versions before this round).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7000
CMD ["node", "src/server.js"]
