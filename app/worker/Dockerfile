FROM node:20-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/shared ./shared
COPY app/worker ./worker
ENV NODE_ENV=production SERVICE_NAME=worker
CMD ["node", "worker/worker.js"]
