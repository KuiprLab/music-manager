FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV NODE_OPTIONS="--unhandled-rejections=throw"

CMD ["sh", "-c", "ls -la node_modules/.bin/ | head -20 && ls -la node_modules/tsx/ 2>&1 | head -10 && node node_modules/tsx/dist/cli.mjs src/index.ts"]
