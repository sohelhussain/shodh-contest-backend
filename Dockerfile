FROM node:20-alpine AS builder

WORKDIR /app

# Install docker CLI so worker can invoke docker if needed
RUN apk add --no-cache docker-cli

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src

RUN npm run build
RUN npx prisma generate

FROM node:20-alpine AS runner

WORKDIR /app
RUN apk add --no-cache docker-cli

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
