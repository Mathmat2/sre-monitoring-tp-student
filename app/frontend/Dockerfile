FROM node:20-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/frontend ./frontend
ENV NODE_ENV=production SERVICE_NAME=frontend PORT=3000
EXPOSE 3000
CMD ["node", "frontend/server.js"]
