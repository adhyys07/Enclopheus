FROM node:22-alpine AS dependencies

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

RUN apk add --no-cache ca-certificates tini && update-ca-certificates

ENV NODE_ENV=production
ENV PORT=3000
ENV SLACK_BOLT_PORT=3001
ENV NODE_OPTIONS=--dns-result-order=ipv4first

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY auth.js db.js index.js ./
COPY public ./public
COPY scripts ./scripts
COPY schema.sql ./

RUN chown -R node:node /app
USER node

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login.html').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
