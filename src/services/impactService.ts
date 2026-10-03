import { prisma } from '../db.js';

export async function getPlatformTotalSum(): Promise<string> {
  const result = await prisma.$queryRaw<[{ total: string | null }]>`
    SELECT SUM(balance::numeric + withdrawn::numeric)::text as total
    FROM "streams";
  `;

  return result[0]?.total ?? '0';
}