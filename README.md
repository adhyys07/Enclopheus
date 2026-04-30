# Enclopheus

Enclopheus is a slack bot for Enclosure YSWS to keep the participants up to date about the status and fulfillment for their project so that participants don't need to DM the organizers.
Enclopheus is hosted on HQ's coolify to manage all the messages and automations.

The app includes:

- Slack Bolt event handling
- Airtable polling for submission review/status notifications
- Docker support for deployment

## What It Can Do

- Keep the user up to date with their enclosure project and fulfillment status
- Add users to the slack channels if the user signed up on enclosure.hackclub.com.
- Send Slack DMs and channel notifications based on Airtable records.
- It updates the user about their grant status with their grant link and tells of what tier the grant is.
- Track sent Airtable notifications to avoid duplicate messages
- DMs rejection messages and approval messages are sent to the channel and dmed personally with feedback
- Support a second Airtable table for additional workflow notifications
- It will send you a cute heyo gang message whenever someone greets the bot.
- Run locally with Node.js or in production with Docker

## Requirements

- Node.js 22 or newer
- npm
- PostgreSQL
- Slack app credentials
- Airtable API credentials, if Airtable notifications are enabled
- A hosting service to keep the operations smooth in the production and it's suggested to use a basic local hosting for local development

## Database Setup

Enclopheus is using Neon DB as their production+development database

```sh
psql "$DATABASE_URL" -f schema.sql
```

The app also creates and updates some notification state tables during startup.

## Local Development

Install dependencies:

```sh
npm install
```

Start the app:

```sh
npm start
```

This will be deployed locally so you can test if the bot is working properly and sending messages correctly.

## Docker

Build the image:

```sh
docker build -t enclopheus .
```

Run the container with your local `.env` file:

```sh
docker run --name enclopheus --env-file .env -p 3000:3000 -p 3001:3001 enclopheus
```

The image also includes a healthcheck that verifies `/login.html` responds on the configured `PORT`.

## Deployment Notes

Before deploying, make sure your platform has:

- All required environment variables configured
- A reachable PostgreSQL database in `DATABASE_URL`
- Inbound routing for the dashboard port
- Slack redirect URLs and event URLs updated to match the deployed domain

If the app exits during startup with a PostgreSQL timeout, the container image is likely fine, but the deployed app cannot reach the database.

## Useful Commands

```sh
npm start
docker build -t enclopheus .
docker run --env-file .env -p 3000:3000 -p 3001:3001 enclopheus
```
