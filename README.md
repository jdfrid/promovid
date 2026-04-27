# AdBot / Promovid

AdBot is an MVP SaaS platform for generating short promotional videos from a product, service, event, or free-form topic.

The first release focuses on:

- Tenant-aware projects and render jobs.
- Script generation with 7-8 second scenes.
- Asset management for images, video, audio, music, avatars, and saved scripts.
- Provider settings for script, media, voice, video, merge, storage, and distribution providers.
- A background render queue with an FFmpeg-based MP4 renderer.
- Docker Compose for local development and low-cost VPS deployment.

## Local Setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

The web app runs at `http://localhost:5173` and the API runs at `http://localhost:4000`.

## Deployment Shape

The recommended low-cost deployment is a Docker Compose stack on a VPS with Cloudflare R2 for object storage. Railway and Render are supported as simpler managed alternatives, but video rendering workers and bandwidth can become more expensive there.

## MVP Boundaries

The codebase includes provider interfaces and starter connectors. Production integrations for social distribution, advanced AI video providers, billing, SSO, MFA, and enterprise schema-per-tenant isolation are planned follow-up stages.
