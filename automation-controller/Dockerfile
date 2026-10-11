FROM node:20-alpine
# docker-cli + plugin compose : pour que les étudiants puissent choisir entre
# l'API Docker et `docker compose up --scale` dans leurs règles (discussion
# sécurité du mount du socket en séance).
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /controller
COPY automation-controller/package*.json ./
RUN npm install --omit=dev
COPY automation-controller/ ./
ENV PORT=5002
EXPOSE 5002
CMD ["node", "index.js"]
