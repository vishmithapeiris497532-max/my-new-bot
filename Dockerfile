FROM node:20-slim
ENV NODE_OPTIONS="--tls-cipher-list=DEFAULT:@SECLEVEL=1 --dns-result-order=ipv4first"
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 8000
CMD ["node", "index.js"]
