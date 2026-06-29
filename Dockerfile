# Simba AI — single-service container (serves the sidebar + /api on one origin).
#
# Build stage installs all deps (incl. build tools) and produces dist/.
# Runtime stage ships only production deps + the server + the built sidebar.

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
# .npmrc (include=dev) ensures build tools install even under NODE_ENV=production.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# No .npmrc here, so --omit=dev prunes build tools → small runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
# The host injects PORT; the server reads process.env.PORT (defaults to 3001).
EXPOSE 3001
CMD ["node", "server/server.js"]
