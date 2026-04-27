import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { ProviderType } from "@prisma/client";
import { prisma } from "../db.js";
import { encryptSecret } from "../crypto.js";

const providerSchema = z.object({
  type: z.nativeEnum(ProviderType),
  provider: z.string().min(2),
  displayName: z.string().min(2),
  apiKey: z.string().optional(),
  priority: z.number().int().min(1).default(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({})
});

const updateProviderSchema = providerSchema.partial().extend({
  apiKey: z.string().optional()
});

export async function providerRoutes(app: FastifyInstance) {
  app.get("/providers", async () => {
    const tenant = await getDemoTenant();
    const providers = await prisma.providerCredential.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ type: "asc" }, { priority: "asc" }]
    });

    return {
      data: providers.map(({ encryptedKey: _encryptedKey, ...provider }) => ({
        ...provider,
        hasSecret: Boolean(_encryptedKey)
      }))
    };
  });

  app.post("/providers", async (request, reply) => {
    const input = providerSchema.parse(request.body);
    const tenant = await getDemoTenant();
    const provider = await prisma.providerCredential.create({
      data: {
        tenantId: tenant.id,
        type: input.type,
        provider: input.provider,
        displayName: input.displayName,
        encryptedKey: input.apiKey ? encryptSecret(input.apiKey) : null,
        priority: input.priority,
        enabled: input.enabled,
        config: input.config as Prisma.InputJsonValue
      }
    });

    reply.code(201);
    return { data: { ...provider, encryptedKey: undefined, hasSecret: Boolean(provider.encryptedKey) } };
  });

  app.patch("/providers/:providerId", async (request) => {
    const params = z.object({ providerId: z.string() }).parse(request.params);
    const input = updateProviderSchema.parse(request.body);
    const tenant = await getDemoTenant();
    const existing = await prisma.providerCredential.findFirstOrThrow({
      where: {
        id: params.providerId,
        tenantId: tenant.id
      }
    });

    const provider = await prisma.providerCredential.update({
      where: {
        id: existing.id
      },
      data: {
        type: input.type,
        provider: input.provider,
        displayName: input.displayName,
        encryptedKey: input.apiKey ? encryptSecret(input.apiKey) : undefined,
        priority: input.priority,
        enabled: input.enabled,
        config: input.config ? (input.config as Prisma.InputJsonValue) : undefined
      }
    });

    return { data: { ...provider, encryptedKey: undefined, hasSecret: Boolean(provider.encryptedKey) } };
  });
}

async function getDemoTenant() {
  return prisma.tenant.findUniqueOrThrow({
    where: { slug: "demo" }
  });
}
