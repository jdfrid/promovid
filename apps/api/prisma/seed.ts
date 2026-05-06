import bcrypt from "bcryptjs";
import { PrismaClient, ProviderType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      slug: "demo",
      name: "Demo Studio",
      brandColor: "#6d5dfc"
    }
  });

  await prisma.user.upsert({
    where: { email: "admin@adbot.local" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@adbot.local",
      name: "AdBot Admin",
      passwordHash: await bcrypt.hash("adbot1234", 12),
      role: "ADMIN"
    }
  });

  const providers: Array<[ProviderType, string, string]> = [
    ["SCRIPT", "openai", "OpenAI Script Writer"],
    ["MEDIA", "pexels", "Pexels Media Search"],
    ["VOICE", "openverse", "Openverse Audio Search"],
    ["VOICE", "elevenlabs", "ElevenLabs Voiceover"],
    ["MUSIC", "openverse", "Openverse Audio Search"],
    ["VIDEO", "shotstack", "Shotstack 5 Second Renderer"],
    ["VIDEO", "gemini", "Gemini Video"],
    ["MERGE", "ffmpeg", "Self-hosted FFmpeg"],
    ["STORAGE", "local", "Local Storage"]
  ];

  for (const [type, provider, displayName] of providers) {
    const existing = await prisma.providerCredential.findFirst({
      where: {
        tenantId: tenant.id,
        type,
        provider
      }
    });

    if (!existing) {
      await prisma.providerCredential.create({
        data: {
          tenantId: tenant.id,
          type,
          provider,
          displayName,
          enabled: provider === "ffmpeg" || provider === "local",
          priority: 1
        }
      });
    }
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
