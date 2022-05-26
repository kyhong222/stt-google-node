From node:12

WorkDir /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

cmd ["npm", "start"]