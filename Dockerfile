FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Hugging Face Spaces dynamically assigns port 7860
EXPOSE 7860
ENV PORT=7860
ENV PASSCODE=1234

CMD ["node", "server.js"]
