FROM node:20-alpine AS web
RUN apk add --no-cache unzip
WORKDIR /src
COPY pips-bot.zip .
RUN unzip -q pips-bot.zip
WORKDIR /src/pips-bot/frontend
RUN npm install && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=web /src/pips-bot/backend/package.json ./
RUN npm install --omit=dev
COPY --from=web /src/pips-bot/backend/ .
COPY --from=web /src/pips-bot/frontend/out ./public
CMD ["node", "server.js"]
