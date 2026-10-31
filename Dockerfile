FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm@9.15.0

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

COPY . .

ENV NODE_ENV=production
ENV CDN_PORT=9080
ENV CDN_HOST=0.0.0.0

EXPOSE 9080

CMD ["node", "server.js"]

