FROM node:20-alpine

WORKDIR /app

# Copia manifesto primeiro para aproveitar cache de camadas
COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
