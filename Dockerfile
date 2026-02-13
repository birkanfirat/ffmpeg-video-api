FROM node:18

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app
COPY . .

RUN npm install

EXPOSE 3000

CMD ["npm", "start"]
