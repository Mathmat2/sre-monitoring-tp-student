FROM node:20-alpine
WORKDIR /receiver
COPY webhook-receiver/package*.json ./
RUN npm install --omit=dev
COPY webhook-receiver/ ./
ENV PORT=5001
EXPOSE 5001
CMD ["node", "index.js"]
