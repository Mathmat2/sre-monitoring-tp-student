FROM node:20-alpine
WORKDIR /injector
COPY chaos-injector/package*.json ./
RUN npm install --omit=dev
COPY chaos-injector/ ./
ENV PORT=4000
EXPOSE 4000
CMD ["node", "index.js"]
