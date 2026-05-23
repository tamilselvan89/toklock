FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/
EXPOSE 4000
ENV TOKLOCK_PORT=4000
CMD ["node", "bin/toklock.mjs"]
