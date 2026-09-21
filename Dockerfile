FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .
EXPOSE 8787
ENV PORT=8787
ENV HOST=0.0.0.0
CMD ["node", "server.js"]
