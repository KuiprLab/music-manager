FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV NODE_OPTIONS="--unhandled-rejections=throw"

CMD ["node_modules/.bin/tsx", "src/index.ts"]
