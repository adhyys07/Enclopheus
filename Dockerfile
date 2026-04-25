FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV SLACK_BOLT_PORT=3001

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY auth.js db.js index.js ./
COPY public ./public
COPY scripts ./scripts
COPY schema.sql ./

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login.html').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
