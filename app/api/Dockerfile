FROM node:20-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/shared ./shared
COPY app/api ./api
ENV NODE_ENV=production SERVICE_NAME=api PORT=3001
EXPOSE 3001
CMD ["node", "api/server.js"]
