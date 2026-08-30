FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
ENV DATABASE_URL=postgresql://postgres:postgres@postgres:5432/amber

EXPOSE 5000

CMD ["node", "server.js"]
