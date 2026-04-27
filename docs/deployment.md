# Deployment

## Recommended MVP Hosting

Use a low-cost VPS with Docker Compose and Cloudflare R2-compatible object storage.

Suggested shape:

- 2 vCPU / 4 GB RAM VPS for the first version.
- Docker Compose stack: web, api, worker, PostgreSQL, Redis.
- Cloudflare R2 for production object storage.
- Coolify, Dokploy, or plain Docker Compose for deployment automation.
- Daily database backups and object storage lifecycle policies.

## Managed Alternatives

- Railway: fastest path from GitHub to a running app, useful while traffic and render volume are low.
- Render: more predictable fixed service structure, but the worker, database, and Redis services can become more expensive than a VPS.
- Vercel/Netlify: good for the web app only, not for the FFmpeg worker.

## Production Checklist

- Replace all values in `.env.example`.
- Use a 32+ byte random `JWT_SECRET`.
- Use a 32+ byte random `ENCRYPTION_KEY`.
- Run `npm run db:migrate` against the production database.
- Configure backups before accepting customer data.
- Put the API and web app behind HTTPS.
- Move `STORAGE_DRIVER` from local to S3/R2 before storing important customer videos.
