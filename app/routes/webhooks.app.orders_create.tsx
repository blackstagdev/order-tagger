import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyTag } from "../orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const email = String(payload?.email || payload?.customer?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return new Response();

  const now = new Date();
  const links = await prisma.taggerCustomer.findMany({
    where: { email },
    include: { tagger: true },
  });

  const tags = new Set<string>();
  for (const link of links) {
    const t = link.tagger;
    if (t.shop !== shop) continue;
    const active = !t.endDate || new Date(t.endDate) >= now;
    if (active) tags.add(t.tag);
  }

  if (tags.size) {
    const orderGid = `gid://shopify/Order/${payload.id}`;
    for (const tag of tags) {
      await applyTag(admin as any, [orderGid], tag);
    }
  }
  return new Response();
};
