FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN yarn build

# ---

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS="--unhandled-rejections=throw"

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist

CMD ["sh", "-c", "node --enable-source-maps dist/deploy-commands.js && node --enable-source-maps dist/index.js"]
