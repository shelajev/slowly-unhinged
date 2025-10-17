# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Bundle app source
COPY . .

# Your app binds to 0.0.0.0
ENV HOST 0.0.0.0
ENV PORT 8080

# Make port 8080 available to the world outside this container
EXPOSE 8080

# Define the command to run your app
CMD ["node", "index.js"]
